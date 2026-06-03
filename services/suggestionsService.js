import mongoose from 'mongoose';
import { Conversation, Friendship, Message, Notification, Plan, User } from '../models/appModels.js';
import { getFreshGoogleAccessToken } from './googleAuthService.js';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;

const WORK_DAY_START_HOUR = 9;
const WORK_DAY_END_HOUR = 22;
const MAX_SLOTS = 5;
const MAX_PLACE_RESULTS = 10;

// Converts incoming string ids into MongoDB ObjectIds, and returns null for invalid ids.
export function toObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

// Keeps user responses small and safe by only returning fields the frontend needs.
export function userSummary(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    profilePicture: user.profilePicture,
    homeArea: user.homeArea,
    homeLat: user.homeLat,
    homeLng: user.homeLng,
  };
}

// Shapes a plan document into the format used by the frontend plan screens.
export function planSummary(plan) {
  const participantUsers = plan.participantIds?.filter(
    (participant) => typeof participant === 'object' && participant.name
  ) ?? [];

  return {
    id: plan._id.toString(),
    title: plan.title,
    creator: typeof plan.creatorId === 'object' && plan.creatorId?.name ? userSummary(plan.creatorId) : undefined,
    location: plan.place?.name ?? 'Selected place',
    place: plan.place,
    scheduledAt: plan.startsAt,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    dateTimeLabel: formatDateTimeLabel(plan.startsAt),
    participants: plan.participantIds?.map((participant) =>
      typeof participant === 'object' && participant.name ? participant.name : participant.toString()
    ) ?? [],
    participantProfiles: participantUsers.map(userSummary),
    conversationId: plan.conversationId?.toString(),
    status: plan.status,
  };
}

// Plan invite cards need less data than full plans, so they get a smaller summary.
function planInviteSummary(plan) {
  return {
    id: plan._id.toString(),
    title: plan.title,
    creator: typeof plan.creatorId === 'object' && plan.creatorId?.name ? userSummary(plan.creatorId) : undefined,
    location: plan.place?.name ?? 'Selected place',
    place: plan.place,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    dateTimeLabel: formatDateTimeLabel(plan.startsAt),
    status: plan.status,
  };
}

// Creates the short readable time label shown beside suggestions and plans.
export function formatDateTimeLabel(dateValue) {
  return new Intl.DateTimeFormat('en-NZ', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(dateValue));
}

// Removes duplicate ids even when some are ObjectIds and some are strings.
function uniqueIds(ids) {
  return [...new Set(ids.map((id) => id.toString()))];
}

// Makes sure suggestions and plans can only include people who are accepted friends.
async function assertAcceptedParticipants(currentUserId, participantIds) {
  const otherIds = participantIds.filter((id) => id.toString() !== currentUserId.toString());

  if (!otherIds.length) {
    return;
  }

  const acceptedFriendships = await Friendship.find({
    status: 'accepted',
    $or: [
      { requesterId: currentUserId, receiverId: { $in: otherIds } },
      { requesterId: { $in: otherIds }, receiverId: currentUserId },
    ],
  });

  const acceptedIds = new Set();
  acceptedFriendships.forEach((friendship) => {
    const requesterId = friendship.requesterId.toString();
    const receiverId = friendship.receiverId.toString();
    acceptedIds.add(requesterId === currentUserId.toString() ? receiverId : requesterId);
  });

  const missingFriend = otherIds.find((id) => !acceptedIds.has(id.toString()));

  if (missingFriend) {
    const error = new Error('Suggestions can only include accepted friends.');
    error.statusCode = 403;
    throw error;
  }
}

// Reads a user's Google Calendar free/busy data for the requested date range.
// If their calendar is not connected or Google fails, we treat them as having no busy blocks
// and report the connection status back to the frontend.
async function fetchBusyBlocks(user, timeMin, timeMax) {
  const accessToken = await getFreshGoogleAccessToken(user);

  if (!accessToken) {
    return {
      userId: user._id.toString(),
      busy: [],
      calendarConnected: false,
    };
  }

  const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: 'primary' }],
    }),
  });

  if (!response.ok) {
    return {
      userId: user._id.toString(),
      busy: [],
      calendarConnected: false,
      calendarError: `Calendar returned ${response.status}`,
    };
  }

  const data = await response.json();
  const busy = data.calendars?.primary?.busy ?? [];

  return {
    userId: user._id.toString(),
    busy: busy.map((block) => ({
      start: new Date(block.start),
      end: new Date(block.end),
    })),
    calendarConnected: true,
  };
}

// Builds the basic "we are willing to suggest plans during these hours" windows.
// Calendar busy blocks are removed later; this only creates daily 9am-10pm windows.
function buildDailyWindows(dateFrom, dateTo) {
  const windows = [];
  const cursor = new Date(dateFrom);
  cursor.setHours(0, 0, 0, 0);

  while (cursor < dateTo) {
    const start = new Date(cursor);
    start.setHours(WORK_DAY_START_HOUR, 0, 0, 0);

    const end = new Date(cursor);
    end.setHours(WORK_DAY_END_HOUR, 0, 0, 0);

    if (end > dateFrom && start < dateTo) {
      windows.push({
        start: new Date(Math.max(start.getTime(), dateFrom.getTime())),
        end: new Date(Math.min(end.getTime(), dateTo.getTime())),
      });
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return windows;
}

// Takes broad available windows and cuts out any time that overlaps calendar events.
function subtractBusyBlocks(windows, busyBlocks) {
  return busyBlocks.reduce((freeWindows, busy) => {
    const busyStart = busy.start.getTime();
    const busyEnd = busy.end.getTime();
    const nextWindows = [];

    freeWindows.forEach((window) => {
      const windowStart = window.start.getTime();
      const windowEnd = window.end.getTime();

      if (busyEnd <= windowStart || busyStart >= windowEnd) {
        nextWindows.push(window);
        return;
      }

      if (busyStart > windowStart) {
        nextWindows.push({ start: window.start, end: new Date(busyStart) });
      }

      if (busyEnd < windowEnd) {
        nextWindows.push({ start: new Date(busyEnd), end: window.end });
      }
    });

    return nextWindows;
  }, windows);
}

// Finds the overlapping parts between two sets of available windows.
// This is how we keep narrowing the result until only times everyone can attend remain.
function intersectWindows(firstWindows, secondWindows) {
  const intersections = [];

  firstWindows.forEach((first) => {
    secondWindows.forEach((second) => {
      const start = new Date(Math.max(first.start.getTime(), second.start.getTime()));
      const end = new Date(Math.min(first.end.getTime(), second.end.getTime()));

      if (end > start) {
        intersections.push({ start, end });
      }
    });
  });

  return intersections;
}

// Combines the calendar results for all participants into a short list of usable suggestions.
function findCommonFreeSlots(calendarResults, dateFrom, dateTo, durationMinutes) {
  const durationMs = durationMinutes * 60 * 1000;
  const dailyWindows = buildDailyWindows(dateFrom, dateTo);

  let commonWindows = dailyWindows;

  calendarResults.forEach((calendar) => {
    const freeWindows = subtractBusyBlocks(dailyWindows, calendar.busy);
    commonWindows = intersectWindows(commonWindows, freeWindows);
  });

  return commonWindows
    .filter((window) => window.end.getTime() - window.start.getTime() >= durationMs)
    .slice(0, MAX_SLOTS)
    .map((window) => ({
      start: window.start,
      end: new Date(window.start.getTime() + durationMs),
      label: formatDateTimeLabel(window.start),
    }));
}

// Finds the average home location for the group so place suggestions are roughly central.
// If nobody has a saved location, the app falls back to Auckland CBD.
function calculateMidpoint(users) {
  const locatedUsers = users.filter(
    (user) => Number.isFinite(user.homeLat) && Number.isFinite(user.homeLng)
  );

  if (!locatedUsers.length) {
    return { lat: -36.8485, lng: 174.7633 };
  }

  return {
    lat: locatedUsers.reduce((sum, user) => sum + user.homeLat, 0) / locatedUsers.length,
    lng: locatedUsers.reduce((sum, user) => sum + user.homeLng, 0) / locatedUsers.length,
  };
}

// Converts app-level activity names into Google Places API place types.
function placesTypesForActivity(activityType) {
  const typeMap = {
    coffee: ['cafe'],
    food: ['restaurant', 'cafe'],
    activity: ['bowling_alley', 'movie_theater', 'amusement_center'],
    outdoors: ['park', 'tourist_attraction'],
  };

  return typeMap[activityType] ?? typeMap.food;
}

// Looks for nearby places that match the activity type around the group's midpoint.
async function fetchPlaceSuggestions({ users, activityType }) {
  const midpoint = calculateMidpoint(users);

  if (!GOOGLE_MAPS_API_KEY) {
    return fallbackPlaces(midpoint, activityType);
  }

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.location,places.rating,places.googleMapsUri',
    },
    body: JSON.stringify({
      includedTypes: placesTypesForActivity(activityType),
      maxResultCount: MAX_PLACE_RESULTS,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: {
          center: {
            latitude: midpoint.lat,
            longitude: midpoint.lng,
          },
          radius: 5000,
        },
      },
    }),
  });

  if (!response.ok) {
    return fallbackPlaces(midpoint, activityType);
  }

  const data = await response.json();
  const places = data.places ?? [];

  if (!places.length) {
    return fallbackPlaces(midpoint, activityType);
  }

  return shufflePlaces(places.map((place) => ({
    name: place.displayName?.text ?? 'Suggested place',
    address: place.formattedAddress ?? '',
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rating: place.rating,
    googleMapsUri: place.googleMapsUri,
  })));
}

// Gives the frontend a usable placeholder when Places API is not configured or has no results.
function fallbackPlaces(midpoint, activityType) {
  const label = activityType === 'coffee' ? 'Cafe' : activityType === 'activity' ? 'Activity Spot' : 'Restaurant';

  return [
    {
      name: `Nearby ${label}`,
      address: 'Add Google Maps API key for live places',
      lat: midpoint.lat,
      lng: midpoint.lng,
      rating: null,
      googleMapsUri: null,
    },
  ];
}

// Loads the current user plus selected friends, after checking everyone is allowed.
async function loadSuggestionUsers(currentUserId, participantIds) {
  const objectIds = uniqueIds([currentUserId, ...participantIds])
    .map(toObjectId)
    .filter(Boolean);

  await assertAcceptedParticipants(toObjectId(currentUserId), objectIds);

  const users = await User.find({ _id: { $in: objectIds } });

  if (users.length !== objectIds.length) {
    const error = new Error('One or more participants could not be found.');
    error.statusCode = 404;
    throw error;
  }

  return users;
}

// Returns the accepted friends that the current user can include in suggestions.
export async function getAcceptedFriends(currentUserId) {
  const currentObjectId = toObjectId(currentUserId);
  const friendships = await Friendship.find({
    status: 'accepted',
    $or: [{ requesterId: currentObjectId }, { receiverId: currentObjectId }],
  }).populate(['requesterId', 'receiverId']);

  return friendships
    .map((friendship) => {
      const requesterId = friendship.requesterId._id.toString();
      return requesterId === currentUserId ? friendship.receiverId : friendship.requesterId;
    })
    .map(userSummary);
}

// Main suggestion workflow used by both the HTTP route and the AI planner.
// It validates input, loads users, fetches calendars and places, then pairs each time slot
// with a suggested place.
export async function suggestHangout(currentUserId, input) {
  const dateFrom = input.dateFrom ? new Date(input.dateFrom) : new Date();
  const dateTo = input.dateTo ? new Date(input.dateTo) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const durationMinutes = Number(input.durationMinutes || 120);
  const participantIds = Array.isArray(input.participantIds) ? input.participantIds : [];
  const activityType = String(input.activityType || 'food').trim() || 'food';

  if (!participantIds.length) {
    const error = new Error('Choose at least one friend.');
    error.statusCode = 400;
    throw error;
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 480) {
    const error = new Error('Duration must be between 30 minutes and 8 hours.');
    error.statusCode = 400;
    throw error;
  }

  if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime()) || dateTo <= dateFrom) {
    const error = new Error('Choose a valid date range.');
    error.statusCode = 400;
    throw error;
  }

  const users = await loadSuggestionUsers(currentUserId, participantIds);
  const [calendarResults, places] = await Promise.all([
    Promise.all(users.map((user) => fetchBusyBlocks(user, dateFrom, dateTo))),
    fetchPlaceSuggestions({ users, activityType }),
  ]);
  const slots = findCommonFreeSlots(calendarResults, dateFrom, dateTo, durationMinutes);

  const suggestions = slots.map((slot, index) => ({
    id: `suggestion-${index + 1}`,
    time: slot,
    place: places[index % places.length],
    participants: users.map(userSummary),
    score: Math.max(70, 96 - index * 7),
  }));

  return {
    suggestions,
    calendarStatus: calendarResults.map((calendar) => ({
      userId: calendar.userId,
      calendarConnected: calendar.calendarConnected,
      calendarError: calendar.calendarError,
    })),
  };
}

// Creates a pending plan from a selected suggestion and invites the other participants.
export async function createPlan(currentUserId, input) {
  const participantIds = Array.isArray(input.participantIds) ? input.participantIds : [];
  const users = await loadSuggestionUsers(currentUserId, participantIds);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);

  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    const error = new Error('Valid plan start and end time are required.');
    error.statusCode = 400;
    throw error;
  }

  const creatorObjectId = toObjectId(currentUserId);
  const invitedObjectIds = users
    .filter((user) => user._id.toString() !== currentUserId)
    .map((user) => user._id);
  const place = input.place ?? {};
  const title = String(input.title || `${place.name || 'Hangout'} plan`).trim();
  const plan = await Plan.create({
    title,
    creatorId: currentUserId,
    participantIds: [creatorObjectId],
    invitedParticipantIds: invitedObjectIds,
    acceptedParticipantIds: [creatorObjectId],
    place: {
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      rating: place.rating,
      googleMapsUri: place.googleMapsUri,
    },
    startsAt,
    endsAt,
    activityType: input.activityType || 'food',
    status: 'pending',
  });

  const populatedPlan = await Plan.findById(plan._id).populate(['participantIds', 'creatorId']);

  return {
    plan: planSummary(populatedPlan),
    invitedCount: invitedObjectIds.length,
  };
}

// Accepts a plan invite, adds the user to the plan, and creates or updates the group chat.
export async function acceptPlanInvite(currentUserId, planId) {
  const plan = await Plan.findOne({
    _id: planId,
    invitedParticipantIds: currentUserId,
    status: { $ne: 'cancelled' },
  });

  if (!plan) {
    const error = new Error('Plan invite not found.');
    error.statusCode = 404;
    throw error;
  }

  const currentObjectId = toObjectId(currentUserId);
  const participantIds = uniqueIds([...plan.participantIds, currentObjectId]).map(toObjectId);
  const acceptedParticipantIds = uniqueIds([...plan.acceptedParticipantIds, currentObjectId]).map(toObjectId);

  let conversation = plan.conversationId
    ? await Conversation.findById(plan.conversationId)
    : null;

  if (!conversation) {
    conversation = await Conversation.create({
      title: plan.title,
      type: 'group',
      participants: participantIds,
    });
    plan.conversationId = conversation._id;
  } else {
    conversation.participants = participantIds;
    await conversation.save();
  }

  plan.participantIds = participantIds;
  plan.acceptedParticipantIds = acceptedParticipantIds;
  plan.status = 'confirmed';
  await plan.save();

  await Message.create({
    conversationId: conversation._id,
    senderId: currentUserId,
    content: `Accepted plan invite: ${plan.title}`,
    readBy: [currentUserId],
  });

  const populatedPlan = await Plan.findById(plan._id).populate(['participantIds', 'creatorId']);

  return {
    plan: planSummary(populatedPlan),
    conversationId: conversation._id.toString(),
  };
}

// Returns upcoming plan invites that the current user has not accepted yet.
export async function getPlanInvites(currentUserId) {
  const plans = await Plan.find({
    invitedParticipantIds: currentUserId,
    acceptedParticipantIds: { $ne: currentUserId },
    status: { $ne: 'cancelled' },
    endsAt: { $gt: new Date() },
  })
    .populate('creatorId')
    .sort({ startsAt: 1 });

  return plans.map(planInviteSummary);
}

// Returns upcoming active plans where the current user is already a participant.
export async function getUserPlans(currentUserId) {
  const plans = await Plan.find({
    participantIds: currentUserId,
    status: { $in: ['pending', 'confirmed'] },
    endsAt: { $gt: new Date() },
  })
    .populate(['participantIds', 'creatorId'])
    .sort({ startsAt: 1 });

  return plans.map(planSummary);
}

// Lets creators, participants, or invited users cancel a plan they are connected to.
export async function cancelPlan(currentUserId, planId) {
  const plan = await Plan.findOneAndUpdate(
    {
      _id: planId,
      $or: [
        { creatorId: currentUserId },
        { participantIds: currentUserId },
        { invitedParticipantIds: currentUserId },
      ],
      status: { $ne: 'cancelled' },
    },
    { $set: { status: 'cancelled' } },
    { new: true }
  ).populate(['participantIds', 'creatorId']);

  if (!plan) {
    const error = new Error('Plan not found.');
    error.statusCode = 404;
    throw error;
  }

  return planSummary(plan);
}
