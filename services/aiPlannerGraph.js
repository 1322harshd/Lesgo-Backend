import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentConversation } from '../models/appModels.js';
import {
  cancelPlan,
  createPlan,
  extractSearchRadiusMetersFromText,
  getAcceptedFriends,
  getUserPlans,
  increaseSearchRadiusMeters,
  normalizeSearchRadiusMeters,
  suggestHangout,
} from './suggestionsService.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const MAX_CONTEXT_MESSAGES = 12;
const DEFAULT_AGENT_DAILY_MESSAGE_LIMIT = 40;
const DEFAULT_AGENT_CONVERSATION_MESSAGE_LIMIT = 20;
const DEFAULT_AGENT_DAILY_CONVERSATION_LIMIT = 8;
const DEFAULT_AGENT_MESSAGE_CHAR_LIMIT = 600;
const AGENT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);

  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

const AGENT_LIMITS = {
  dailyMessageLimit: readPositiveIntegerEnv('AGENT_DAILY_MESSAGE_LIMIT', DEFAULT_AGENT_DAILY_MESSAGE_LIMIT),
  conversationMessageLimit: readPositiveIntegerEnv(
    'AGENT_CONVERSATION_MESSAGE_LIMIT',
    DEFAULT_AGENT_CONVERSATION_MESSAGE_LIMIT
  ),
  dailyConversationLimit: readPositiveIntegerEnv(
    'AGENT_DAILY_CONVERSATION_LIMIT',
    DEFAULT_AGENT_DAILY_CONVERSATION_LIMIT
  ),
  messageCharLimit: readPositiveIntegerEnv('AGENT_MESSAGE_CHAR_LIMIT', DEFAULT_AGENT_MESSAGE_CHAR_LIMIT),
};

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

function agentLimitError(message, limitDetails) {
  const error = new Error(message);
  error.statusCode = 429;
  error.limitDetails = limitDetails;
  return error;
}

function usageWindowStart(now = new Date()) {
  return new Date(now.getTime() - AGENT_USAGE_WINDOW_MS);
}

function countConversationUserMessages(conversation) {
  return (conversation.messages ?? []).filter((message) => message.role === 'user').length;
}

async function getUserAgentMessagesInWindow(userId, windowStart) {
  const conversations = await AgentConversation.find({
    userId,
    'messages.createdAt': { $gte: windowStart },
  }).select('messages.role messages.createdAt');

  return conversations
    .flatMap((conversation) => conversation.messages ?? [])
    .filter((message) => message.role === 'user' && new Date(message.createdAt).getTime() >= windowStart.getTime());
}

async function assertAgentConversationStartAllowed(userId) {
  const windowStart = usageWindowStart();
  const conversationCount = await AgentConversation.countDocuments({
    userId,
    createdAt: { $gte: windowStart },
  });

  if (conversationCount >= AGENT_LIMITS.dailyConversationLimit) {
    throw agentLimitError(
      `AI planner conversation limit reached. You can start ${AGENT_LIMITS.dailyConversationLimit} AI conversations per 24 hours.`,
      {
        type: 'daily_conversation_limit',
        limit: AGENT_LIMITS.dailyConversationLimit,
        used: conversationCount,
        windowHours: 24,
      }
    );
  }
}

async function assertAgentMessageAllowed({ userId, conversation, message }) {
  if (message.length > AGENT_LIMITS.messageCharLimit) {
    const error = new Error(`Message is too long. Keep AI planner messages under ${AGENT_LIMITS.messageCharLimit} characters.`);
    error.statusCode = 413;
    error.limitDetails = {
      type: 'message_length_limit',
      limit: AGENT_LIMITS.messageCharLimit,
      used: message.length,
    };
    throw error;
  }

  const conversationMessageCount = countConversationUserMessages(conversation);

  if (conversationMessageCount >= AGENT_LIMITS.conversationMessageLimit) {
    throw agentLimitError(
      `This AI conversation has reached its ${AGENT_LIMITS.conversationMessageLimit} message limit. Start a new AI planner chat later.`,
      {
        type: 'conversation_message_limit',
        limit: AGENT_LIMITS.conversationMessageLimit,
        used: conversationMessageCount,
      }
    );
  }

  const windowStart = usageWindowStart();
  const recentMessages = await getUserAgentMessagesInWindow(userId, windowStart);

  if (recentMessages.length >= AGENT_LIMITS.dailyMessageLimit) {
    const oldestMessage = recentMessages
      .map((message) => new Date(message.createdAt))
      .sort((first, second) => first.getTime() - second.getTime())[0];
    const resetAt = oldestMessage
      ? new Date(oldestMessage.getTime() + AGENT_USAGE_WINDOW_MS)
      : new Date(Date.now() + AGENT_USAGE_WINDOW_MS);

    throw agentLimitError(
      `AI planner limit reached. You can send ${AGENT_LIMITS.dailyMessageLimit} AI planner messages per 24 hours.`,
      {
        type: 'daily_message_limit',
        limit: AGENT_LIMITS.dailyMessageLimit,
        used: recentMessages.length,
        windowHours: 24,
        resetAt,
      }
    );
  }
}

//helper function to normalise response from OpenAi into simple string
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
  const validActions = new Set([
    'ask_question',
    'suggest_hangout',
    'create_plan',
    'list_plans',
    'cancel_plan',
    'general_reply',
  ]);
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
    searchRadiusMeters: Number.isFinite(Number(intent.searchRadiusMeters)) ? Number(intent.searchRadiusMeters) : null,
    title: intent.title ? String(intent.title) : null,
    selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, Number.isInteger(intent.selectedSuggestionIndex) ? intent.selectedSuggestionIndex : null),
    selectedPlanIndex: inferSelectedSuggestionIndex(userMessage, Number.isInteger(intent.selectedPlanIndex) ? intent.selectedPlanIndex : null),
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

function planListSummary(plans = []) {
  if (!plans.length) {
    return 'No upcoming plans have been listed yet.';
  }

  return plans
    .map((plan, index) => (
      `${index + 1}. ${plan.title} on ${plan.dateTimeLabel} at ${plan.location}`
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

function isListPlansMessage(message) {
  return /\b(show|list|see|check|view)\b/i.test(message) &&
    /\b(plan|plans|upcoming|schedule)\b/i.test(message);
}

function isCancelPlanMessage(message) {
  return /\b(cancel|delete|remove)\b/i.test(message) &&
    /\b(plan|plans|booking|hangout|event|first|second|third|option|#?\d)\b/i.test(message);
}

function isSearchRadiusPrompt(message) {
  const text = String(message || '');
  return /\b(radius|search area|wider|broader|expand|farther|further|further away|farther away|more places|more options|within\s+\d)\b/i.test(text) ||
    (/\bincrease\b/i.test(text) && /\b(radius|search|area|distance|range)\b/i.test(text));
}

function isOptionsMessage(message) {
  return /\b(option|options|suggestion|suggestions|choices|ideas|find|search)\b/i.test(message);
}

function isPlanningMessage(message) {
  return /\b(plan|coffee|food|lunch|dinner|breakfast|hangout|meet|meeting|movie|activity|option|options|suggestion|suggestions)\b/i.test(message);
}

function defaultDurationMinutesForActivity(activityType) {
  return activityType === 'coffee' ? 60 : 120;
}

function mentionsActivityType(message) {
  return /\b(coffee|food|lunch|dinner|breakfast|restaurant|cafe|bar|activity|outdoors|park|movie)\b/i.test(message);
}

function planningIntentSnapshot(intent, participantIds) {
  return {
    participantIds,
    dateFrom: intent.dateFrom,
    dateTo: intent.dateTo,
    durationMinutes: intent.durationMinutes,
    activityType: intent.activityType,
    searchRadiusMeters: intent.searchRadiusMeters,
    title: intent.title,
  };
}

function mergePendingIntent({ intent, participantIds, pendingIntent, userMessage }) {
  const pending = pendingIntent ?? {};

  return {
    ...intent,
    participantIds: participantIds.length ? participantIds : pending.participantIds ?? [],
    dateFrom: intent.dateFrom ?? pending.dateFrom ?? null,
    dateTo: intent.dateTo ?? pending.dateTo ?? null,
    durationMinutes: intent.durationMinutes ?? pending.durationMinutes ?? null,
    activityType: mentionsActivityType(userMessage)
      ? intent.activityType
      : pending.activityType ?? intent.activityType,
    searchRadiusMeters: intent.searchRadiusMeters ?? pending.searchRadiusMeters ?? null,
    title: intent.title ?? pending.title ?? null,
  };
}

function hasSuggestionInput(intent) {
  return Boolean(
    intent.participantIds?.length &&
    intent.dateFrom &&
    intent.dateTo &&
    intent.durationMinutes
  );
}

function looksLikeCompletionClaim(message) {
  return /\b(scheduled|created|creating|booked|booking|set up|done|confirmed)\b/i.test(message);
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

function getRequestedSearchRadiusMeters(message, parsedRadiusMeters) {
  const extractedRadiusMeters = extractSearchRadiusMetersFromText(message);

  if (extractedRadiusMeters !== null) {
    return normalizeSearchRadiusMeters(extractedRadiusMeters);
  }

  if (Number.isFinite(Number(parsedRadiusMeters)) && isSearchRadiusPrompt(message)) {
    return normalizeSearchRadiusMeters(parsedRadiusMeters);
  }

  return null;
}

function formatSearchRadius(radiusMeters) {
  if (!Number.isFinite(Number(radiusMeters))) {
    return null;
  }

  if (radiusMeters >= 1000) {
    return `${Math.round((radiusMeters / 1000) * 10) / 10}km`;
  }

  return `${radiusMeters}m`;
}

function formatSuggestionsReply(suggestions, { searchRadiusMeters, mentionRadius = false } = {}) {
  if (!suggestions.length) {
    return 'I could not find a free slot for that plan. Want to try a wider time range or a shorter duration?';
  }

  const radiusLabel = mentionRadius ? formatSearchRadius(searchRadiusMeters) : null;
  const options = suggestions
    .map((suggestion, index) => (
      `${index + 1}. ${suggestion.time.label} at ${suggestion.place.name}`
    ))
    .join('\n');

  return `${radiusLabel ? `I searched within ${radiusLabel}.\n` : ''}I found these options:\n${options}\n\nWhich one should I create?`;
}

function formatPlansReply(plans) {
  if (!plans.length) {
    return 'You do not have any upcoming plans right now.';
  }

  const options = plans
    .map((plan, index) => (
      `${index + 1}. ${plan.title} - ${plan.dateTimeLabel} at ${plan.location}`
    ))
    .join('\n');

  return `Here are your upcoming plans:\n${options}\n\nTell me which one you want to cancel.`;
}

function findPlanMatch({ plans, title, selectedPlanIndex }) {
  if (Number.isInteger(selectedPlanIndex) && selectedPlanIndex >= 0) {
    return plans[selectedPlanIndex] ?? null;
  }

  const normalizedTitle = normalizeText(title);

  if (!normalizedTitle) {
    return null;
  }

  return plans.find((plan) => {
    const planTitle = normalizeText(plan.title);
    const location = normalizeText(plan.location);
    return planTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(planTitle) ||
      location.includes(normalizedTitle);
  }) ?? null;
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
      searchRadiusMeters: null,
      title: null,
      selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, null),
      selectedPlanIndex: inferSelectedSuggestionIndex(userMessage, null),
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
- If the user starts with words like "plan coffee..." or "make dinner plans..." but no previous suggestions exist, use "suggest_hangout".
- If user selects "first", selectedSuggestionIndex must be 0; "second" is 1.
- If the user asks to see, list, show, or check upcoming plans, use action "list_plans".
- If the user asks to cancel/delete/remove an upcoming plan, use action "cancel_plan".
- For cancel_plan, set selectedPlanIndex when they choose a numbered listed plan, and set title when they mention a plan name or place.
- Only set searchRadiusMeters when the user explicitly asks to increase/widen/expand the search radius or gives a radius/distance like "within 10km".
- If the user does not mention search radius, leave searchRadiusMeters as null.
- For simple greetings or non-planning chat, use action "general_reply".
- Return only a JSON object. Do not use markdown.

JSON shape:
{
  "action": "ask_question" | "suggest_hangout" | "create_plan" | "list_plans" | "cancel_plan" | "general_reply",
  "reply": "short friendly message",
  "friendNames": [],
  "includeAllFriends": false,
  "activityType": "coffee" | "food" | "activity" | "outdoors",
  "dateFrom": null,
  "dateTo": null,
  "durationMinutes": null,
  "searchRadiusMeters": null,
  "title": null,
  "selectedSuggestionIndex": null,
  "selectedPlanIndex": null,
  "missingInfo": []
}

Accepted friends:
${friendList}

Previous suggestions:
${suggestionSummary(conversation.agentState?.lastSuggestions)}

Previously listed upcoming plans:
${planListSummary(conversation.agentState?.lastPlans)}

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
      searchRadiusMeters: null,
      title: null,
      selectedSuggestionIndex: inferSelectedSuggestionIndex(userMessage, null),
      selectedPlanIndex: inferSelectedSuggestionIndex(userMessage, null),
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
  if (isListPlansMessage(userMessage)) {
    intent.action = 'list_plans';
  }
  if (isCancelPlanMessage(userMessage)) {
    intent.action = 'cancel_plan';
  }

  const selectedSuggestionIndex = inferSelectedSuggestionIndex(userMessage, intent.selectedSuggestionIndex);
  const selectedPlanIndex = inferSelectedSuggestionIndex(userMessage, intent.selectedPlanIndex);
  const lastSuggestions = conversation.agentState?.lastSuggestions ?? [];
  const lastPlans = conversation.agentState?.lastPlans ?? [];
  const lastSuggestionRequest = conversation.agentState?.lastSuggestionRequest ?? null;
  const storedPendingIntent = conversation.agentState?.pendingIntent ?? null;
  const pendingCancelPlan = conversation.agentState?.pendingCancelPlan ?? null;
  const isConfirmingSuggestion = isConfirmationMessage(userMessage) && lastSuggestions.length > 0;
  const requestedSearchRadiusMeters = getRequestedSearchRadiusMeters(userMessage, intent.searchRadiusMeters);
  if (lastPlans.length && /\bcancel\b/i.test(userMessage)) {
    intent.action = 'cancel_plan';
  }
  const { participantIds, unresolvedNames } = resolveParticipants({
    friends,
    friendNames: intent.friendNames,
    includeAllFriends: intent.includeAllFriends,
  });

  if (unresolvedNames.length) {
    return {
      result: {
        reply: `I could not find ${unresolvedNames.join(', ')} in your accepted friends. Which friend should I include?`,
      },
    };
  }

  const mergedIntent = mergePendingIntent({
    intent,
    participantIds,
    pendingIntent: storedPendingIntent,
    userMessage,
  });

  if (
    !mergedIntent.durationMinutes &&
    mergedIntent.participantIds.length &&
    mergedIntent.dateFrom &&
    mergedIntent.dateTo
  ) {
    mergedIntent.durationMinutes = defaultDurationMinutesForActivity(mergedIntent.activityType);
  }

  if (
    isOptionsMessage(userMessage) &&
    !isCancelPlanMessage(userMessage) &&
    (storedPendingIntent || hasSuggestionInput(mergedIntent))
  ) {
    intent.action = 'suggest_hangout';
  }

  if (
    intent.action === 'general_reply' &&
    (storedPendingIntent || isPlanningMessage(userMessage)) &&
    !isListPlansMessage(userMessage) &&
    !isCancelPlanMessage(userMessage)
  ) {
    intent.action = isOptionsMessage(userMessage) || hasSuggestionInput(mergedIntent)
      ? 'suggest_hangout'
      : 'ask_question';
  }

  if (intent.action === 'ask_question' && storedPendingIntent && hasSuggestionInput(mergedIntent)) {
    intent.action = 'suggest_hangout';
  }

  if (
    looksLikeCompletionClaim(intent.reply) &&
    intent.action !== 'create_plan' &&
    intent.action !== 'cancel_plan'
  ) {
    intent.reply = 'I have the details so far. I can find a few options next.';
  }

  if (pendingCancelPlan && isConfirmationMessage(userMessage)) {
    const cancelResult = await cancelPlan(userId, pendingCancelPlan.id);

    return {
      result: {
        reply: `Done. I cancelled "${pendingCancelPlan.title}".`,
        cancelResult,
        nextAgentState: {
          ...conversation.agentState,
          pendingCancelPlan: null,
          lastPlans: [],
        },
      },
    };
  }

  if (isSearchRadiusPrompt(userMessage) && lastSuggestionRequest) {
    const nextSearchRadiusMeters = requestedSearchRadiusMeters ??
      increaseSearchRadiusMeters(lastSuggestionRequest.searchRadiusMeters);
    const suggestionResult = await suggestHangout(userId, {
      ...lastSuggestionRequest,
      searchRadiusMeters: nextSearchRadiusMeters,
    });
    const nextSuggestionRequest = {
      ...lastSuggestionRequest,
      searchRadiusMeters: suggestionResult.searchRadiusMeters,
    };

    return {
      result: {
        reply: formatSuggestionsReply(suggestionResult.suggestions, {
          searchRadiusMeters: suggestionResult.searchRadiusMeters,
          mentionRadius: true,
        }),
        suggestions: suggestionResult.suggestions,
        searchRadiusMeters: suggestionResult.searchRadiusMeters,
        calendarStatus: suggestionResult.calendarStatus,
        nextAgentState: {
          ...conversation.agentState,
          lastSuggestions: suggestionResult.suggestions,
          lastSuggestionRequest: nextSuggestionRequest,
          lastPlans: [],
          pendingIntent: {
            ...(conversation.agentState?.pendingIntent ?? {}),
            searchRadiusMeters: suggestionResult.searchRadiusMeters,
          },
          awaitingConfirmation: suggestionResult.suggestions.length > 0,
        },
      },
    };
  }

  if (intent.action === 'list_plans') {
    const plans = await getUserPlans(userId);

    return {
      result: {
        reply: formatPlansReply(plans),
        plans,
        nextAgentState: {
          ...conversation.agentState,
          lastPlans: plans,
          pendingCancelPlan: null,
        },
      },
    };
  }

  if (intent.action === 'cancel_plan') {
    const plans = lastPlans.length ? lastPlans : await getUserPlans(userId);

    if (!plans.length) {
      return {
        result: {
          reply: 'You do not have any upcoming plans to cancel.',
          nextAgentState: {
            ...conversation.agentState,
            lastPlans: [],
            pendingCancelPlan: null,
          },
        },
      };
    }

    let plan = findPlanMatch({
      plans,
      title: intent.title,
      selectedPlanIndex,
    });

    if (!plan && plans.length === 1) {
      [plan] = plans;
    }

    if (!plan) {
      return {
        result: {
          reply: formatPlansReply(plans),
          plans,
          nextAgentState: {
            ...conversation.agentState,
            lastPlans: plans,
            pendingCancelPlan: null,
          },
        },
      };
    }

    const cancelResult = await cancelPlan(userId, plan.id);

    return {
      result: {
        reply: `Done. I cancelled "${plan.title}".`,
        cancelResult,
        nextAgentState: {
          ...conversation.agentState,
          lastPlans: [],
          pendingCancelPlan: null,
        },
      },
    };
  }

  if (lastSuggestions.length && (intent.action === 'create_plan' || isConfirmingSuggestion)) {
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
      activityType: lastSuggestionRequest?.activityType ?? intent.activityType,
    });

    return {
      result: {
        reply: `Done. I created "${planResult.plan.title}" for ${planResult.plan.dateTimeLabel} at ${planResult.plan.location}.`,
        plan: planResult.plan,
        nextAgentState: {
          ...conversation.agentState,
          lastSuggestions: [],
          lastPlans: [],
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
    !mergedIntent.participantIds.length ||
    !mergedIntent.dateFrom ||
    !mergedIntent.dateTo ||
    !mergedIntent.durationMinutes
  ) {
    return {
      result: {
        reply: intent.reply || 'Who should I include, and when should I look for a free time?',
        nextAgentState: {
          ...conversation.agentState,
          pendingIntent: planningIntentSnapshot(mergedIntent, mergedIntent.participantIds),
        },
      },
    };
  }

  const suggestionResult = await suggestHangout(userId, {
    participantIds: mergedIntent.participantIds,
    dateFrom: mergedIntent.dateFrom,
    dateTo: mergedIntent.dateTo,
    durationMinutes: mergedIntent.durationMinutes,
    activityType: mergedIntent.activityType,
    ...(requestedSearchRadiusMeters !== null ? { searchRadiusMeters: requestedSearchRadiusMeters } : {}),
  });
  const lastSuggestionRequestForState = {
    participantIds: mergedIntent.participantIds,
    dateFrom: mergedIntent.dateFrom,
    dateTo: mergedIntent.dateTo,
    durationMinutes: mergedIntent.durationMinutes,
    activityType: mergedIntent.activityType,
    searchRadiusMeters: suggestionResult.searchRadiusMeters,
  };

  return {
    result: {
      reply: formatSuggestionsReply(suggestionResult.suggestions, {
        searchRadiusMeters: suggestionResult.searchRadiusMeters,
        mentionRadius: requestedSearchRadiusMeters !== null,
      }),
      suggestions: suggestionResult.suggestions,
      searchRadiusMeters: suggestionResult.searchRadiusMeters,
      calendarStatus: suggestionResult.calendarStatus,
      nextAgentState: {
        ...conversation.agentState,
        lastSuggestions: suggestionResult.suggestions,
        lastSuggestionRequest: lastSuggestionRequestForState,
        lastPlans: [],
        pendingIntent: {
          ...intent,
          searchRadiusMeters: suggestionResult.searchRadiusMeters,
        },
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
  await assertAgentConversationStartAllowed(userId);

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

  await assertAgentMessageAllowed({
    userId,
    conversation,
    message: trimmedMessage,
  });

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
      plans: result.plans,
      cancelResult: result.cancelResult,
      searchRadiusMeters: result.searchRadiusMeters,
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
    plans: result.plans ?? [],
    cancelResult: result.cancelResult,
    searchRadiusMeters: result.searchRadiusMeters,
    calendarStatus: result.calendarStatus ?? [],
  };
}
