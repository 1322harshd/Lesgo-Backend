import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentConversation } from '../models/appModels.js';
import { createPlan, getAcceptedFriends, suggestHangout } from './suggestionsService.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const MAX_CONTEXT_MESSAGES = 12;

//defining 'Plannerstate' for shape of state data flowing through the graph
const PlannerState = Annotation.Root({
  userId: Annotation(),
  conversation: Annotation(),
  userMessage: Annotation(),
  result: Annotation(),
});

//creating new model for llm
function createModel() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new ChatOpenAI({
    model: DEFAULT_MODEL,
    temperature: 0.2,
  });
}

function extractJsonObject(content) {
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part.text ?? '')).join('')
    : String(content ?? '');
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1] ?? text;
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('AI did not return a JSON object.');
  }

  return JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
}


function normalizePlannerIntent(intent, userMessage) {
  const validActions = new Set(['ask_question', 'suggest_hangout', 'create_plan', 'general_reply']);
  const validActivities = new Set(['coffee', 'food', 'activity', 'outdoors']);

  return {
    action: validActions.has(intent.action) ? intent.action : 'general_reply',
    reply: String(intent.reply || 'Tell me who you want to invite and roughly when.'),
    friendNames: Array.isArray(intent.friendNames) ? intent.friendNames.map(String) : [],
    includeAllFriends: Boolean(intent.includeAllFriends),
    activityType: validActivities.has(intent.activityType) ? intent.activityType : 'food',
    dateFrom: intent.dateFrom ? String(intent.dateFrom) : null,
    dateTo: intent.dateTo ? String(intent.dateTo) : null,
    durationMinutes: Number.isFinite(Number(intent.durationMinutes)) ? Number(intent.durationMinutes) : null,
    title: intent.title ? String(intent.title) : null,
    selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, Number.isInteger(intent.selectedSuggestionIndex) ? intent.selectedSuggestionIndex : null),
    missingInfo: Array.isArray(intent.missingInfo) ? intent.missingInfo.map(String) : [],
  };
}

function recentMessages(conversation) {
  return (conversation.messages ?? [])
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}

function suggestionSummary(suggestions = []) {
  if (!suggestions.length) {
    return 'No suggestions have been generated yet.';
  }

  return suggestions
    .map((suggestion, index) => (
      `${index + 1}. ${suggestion.time?.label ?? suggestion.time?.start} at ${suggestion.place?.name ?? 'a suggested place'}`
    ))
    .join('\n');
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveParticipants({ friends, friendNames, includeAllFriends }) {
  if (includeAllFriends) {
    return {
      participantIds: friends.map((friend) => friend.id),
      unresolvedNames: [],
    };
  }

  const participantIds = [];
  const unresolvedNames = [];

  friendNames.forEach((friendName) => {
    const needle = normalizeText(friendName);
    const match = friends.find((friend) => {
      const name = normalizeText(friend.name);
      const email = normalizeText(friend.email);
      return name === needle || name.includes(needle) || needle.includes(name) || email === needle;
    });

    if (match) {
      participantIds.push(match.id);
    } else if (needle) {
      unresolvedNames.push(friendName);
    }
  });

  return {
    participantIds: [...new Set(participantIds)],
    unresolvedNames,
  };
}

function isConfirmationMessage(message) {
  return /\b(yes|yeah|yep|sure|confirm|create|book|make it|go ahead)\b/i.test(message);
}

function inferSelectedSuggestionIndex(message, parsedIndex) {
  if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
    return parsedIndex;
  }

  if (/\b(first|1st|one|option 1|#1)\b/i.test(message)) return 0;
  if (/\b(second|2nd|two|option 2|#2)\b/i.test(message)) return 1;
  if (/\b(third|3rd|three|option 3|#3)\b/i.test(message)) return 2;
  if (/\b(fourth|4th|four|option 4|#4)\b/i.test(message)) return 3;
  if (/\b(fifth|5th|five|option 5|#5)\b/i.test(message)) return 4;

  return null;
}

function formatSuggestionsReply(suggestions) {
  if (!suggestions.length) {
    return 'I could not find a free slot for that plan. Want to try a wider time range or a shorter duration?';
  }

  const options = suggestions
    .map((suggestion, index) => (
      `${index + 1}. ${suggestion.time.label} at ${suggestion.place.name}`
    ))
    .join('\n');

  return `I found these options:\n${options}\n\nWhich one should I create?`;
}

async function parsePlannerIntent({ conversation, userMessage, friends }) {
  const model = createModel();

  if (!model) {
    return {
      action: 'ask_question',
      reply: 'AI planning needs OPENAI_API_KEY set in the backend .env before I can understand natural language requests.',
      friendNames: [],
      includeAllFriends: false,
      activityType: 'food',
      dateFrom: null,
      dateTo: null,
      durationMinutes: null,
      title: null,
      selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, null),
      missingInfo: ['OPENAI_API_KEY'],
    };
  }

  const now = new Date();
  const friendList = friends.map((friend) => `${friend.name} <${friend.email}> id=${friend.id}`).join('\n') || 'No accepted friends yet.';

  const response = await model.invoke([
    new SystemMessage(`You are LesGo's AI planning assistant.
Turn natural language into safe planning actions.
Current date/time: ${now.toISOString()}.
Use ISO datetimes. Interpret relative dates in the user's local Auckland/New Zealand context.

Rules:
- Only plan with accepted friends listed below.
- If friend names, date/time range, or duration are missing, ask a concise follow-up.
- For vague times: morning=09:00-12:00, afternoon=12:00-17:00, evening=17:00-22:00.
- If the user says "friends", "all friends", or "everyone", set includeAllFriends=true.
- Never create a plan unless the user clearly confirms a previously suggested option.
- If user selects "first", selectedSuggestionIndex must be 0; "second" is 1.
- For simple greetings or non-planning chat, use action "general_reply".
- Return only a JSON object. Do not use markdown.

JSON shape:
{
  "action": "ask_question" | "suggest_hangout" | "create_plan" | "general_reply",
  "reply": "short friendly message",
  "friendNames": [],
  "includeAllFriends": false,
  "activityType": "coffee" | "food" | "activity" | "outdoors",
  "dateFrom": null,
  "dateTo": null,
  "durationMinutes": null,
  "title": null,
  "selectedSuggestionIndex": null,
  "missingInfo": []
}

Accepted friends:
${friendList}

Previous suggestions:
${suggestionSummary(conversation.agentState?.lastSuggestions)}

Recent conversation:
${recentMessages(conversation)}`),
    new HumanMessage(userMessage),
  ]);

  try {
    return normalizePlannerIntent(extractJsonObject(response.content), userMessage);
  } catch (error) {
    console.warn('AI planner returned non-JSON content:', {
      message: error.message,
      content: response.content,
    });

    return {
      action: 'general_reply',
      reply: typeof response.content === 'string'
        ? response.content
        : 'Hi. Tell me who you want to invite and roughly when, and I can help plan it.',
      friendNames: [],
      includeAllFriends: false,
      activityType: 'food',
      dateFrom: null,
      dateTo: null,
      durationMinutes: null,
      title: null,
      selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, null),
      missingInfo: [],
    };
  }
}

async function plannerNode(state) {
  const { userId, conversation, userMessage } = state;
  const friends = await getAcceptedFriends(userId);
  let intent;

  try {
    intent = await parsePlannerIntent({ conversation, userMessage, friends });
  } catch (error) {
    console.error('AI planner failed to parse intent:', error);

    return {
      result: {
        reply: 'I had trouble understanding that message. Try asking me something like "Plan coffee with Aman tomorrow evening."',
      },
    };
  }
  const selectedSuggestionIndex = inferSelectedSuggestionIndex(userMessage, intent.selectedSuggestionIndex);
  const { participantIds, unresolvedNames } = resolveParticipants({
    friends,
    friendNames: intent.friendNames,
    includeAllFriends: intent.includeAllFriends,
  });
  const lastSuggestions = conversation.agentState?.lastSuggestions ?? [];

  if (unresolvedNames.length) {
    return {
      result: {
        reply: `I could not find ${unresolvedNames.join(', ')} in your accepted friends. Which friend should I include?`,
      },
    };
  }

  if (intent.action === 'create_plan' || (isConfirmationMessage(userMessage) && lastSuggestions.length)) {
    if (!lastSuggestions.length) {
      return {
        result: {
          reply: 'I can create a plan after I suggest some options first. Tell me who, when, and what kind of hangout you want.',
        },
      };
    }

    const suggestion = lastSuggestions[selectedSuggestionIndex ?? 0];

    if (!suggestion) {
      return {
        result: {
          reply: `I only have ${lastSuggestions.length} option${lastSuggestions.length === 1 ? '' : 's'} ready. Which one should I create?`,
          suggestions: lastSuggestions,
        },
      };
    }

    const planResult = await createPlan(userId, {
      title: intent.title || `${suggestion.place.name} plan`,
      participantIds: suggestion.participants
        .map((participant) => participant.id)
        .filter((id) => id !== userId),
      startsAt: suggestion.time.start,
      endsAt: suggestion.time.end,
      place: suggestion.place,
      activityType: intent.activityType,
    });

    return {
      result: {
        reply: `Done. I created "${planResult.plan.title}" for ${planResult.plan.dateTimeLabel} at ${planResult.plan.location}.`,
        plan: planResult.plan,
        nextAgentState: {
          ...conversation.agentState,
          lastSuggestions: [],
          awaitingConfirmation: false,
        },
      },
    };
  }

  if (intent.action === 'general_reply') {
    return {
      result: {
        reply: intent.reply || 'Tell me who you want to hang out with and roughly when, and I can find options.',
      },
    };
  }

  if (
    intent.action === 'ask_question' ||
    !participantIds.length ||
    !intent.dateFrom ||
    !intent.dateTo ||
    !intent.durationMinutes
  ) {
    return {
      result: {
        reply: intent.reply || 'Who should I include, and when should I look for a free time?',
      },
    };
  }

  const suggestionResult = await suggestHangout(userId, {
    participantIds,
    dateFrom: intent.dateFrom,
    dateTo: intent.dateTo,
    durationMinutes: intent.durationMinutes,
    activityType: intent.activityType,
  });

  return {
    result: {
      reply: formatSuggestionsReply(suggestionResult.suggestions),
      suggestions: suggestionResult.suggestions,
      calendarStatus: suggestionResult.calendarStatus,
      nextAgentState: {
        ...conversation.agentState,
        lastSuggestions: suggestionResult.suggestions,
        pendingIntent: intent,
        awaitingConfirmation: suggestionResult.suggestions.length > 0,
      },
    },
  };
}

const plannerGraph = new StateGraph(PlannerState)
  .addNode('planner', plannerNode)
  .addEdge(START, 'planner')
  .addEdge('planner', END)
  .compile();

  //function to create new conversation in database 
  //returns new conversation id and initial reply
export async function startAgentConversation(userId) {
  const conversation = await AgentConversation.create({
    userId,
    title: 'AI planner',
    messages: [],
    agentState: {},
  });

  return {
    conversationId: conversation._id.toString(),
    reply: 'Tell me what you want to plan, who to invite, and roughly when.',
  };
}

//route for filtering user message, updating conversation between user and agent, invoking agent for response and finally giving response from agent
export async function sendAgentMessage({ userId, conversationId, message }) {
  const trimmedMessage = String(message || '').trim();

  if (!trimmedMessage) {
    const error = new Error('Message is required.');
    error.statusCode = 400;
    throw error;
  }

  const conversation = await AgentConversation.findOne({
    _id: conversationId,
    userId,
    status: 'active',
  });

  if (!conversation) {
    const error = new Error('AI conversation not found.');
    error.statusCode = 404;
    throw error;
  }

  conversation.messages.push({
    role: 'user',
    content: trimmedMessage,
  });

  const graphResult = await plannerGraph.invoke({
    userId,
    conversation,
    userMessage: trimmedMessage,
  });
  const result = graphResult.result ?? {
    reply: 'I could not process that request. Try asking me to plan something with a friend and time range.',
  };

  conversation.messages.push({
    role: 'assistant',
    content: result.reply,
    data: {
      suggestions: result.suggestions,
      plan: result.plan,
      calendarStatus: result.calendarStatus,
    },
  });
  conversation.agentState = result.nextAgentState ?? conversation.agentState ?? {};
  await conversation.save();

  return {
    conversationId: conversation._id.toString(),
    reply: result.reply,
    suggestions: result.suggestions ?? [],
    plan: result.plan,
    calendarStatus: result.calendarStatus ?? [],
  };
}
