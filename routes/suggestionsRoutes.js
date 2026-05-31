import express from 'express';
import mongoose from 'mongoose';
import { protect } from '../middleware/authMiddleware.js';
import { Conversation, Friendship, Message, Plan, User } from '../models/appModels.js';
import { getFreshGoogleAccessToken } from '../services/googleAuthService.js';

const router = express.Router();
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;

const WORK_DAY_START_HOUR = 9;
const WORK_DAY_END_HOUR = 22;
const MAX_SLOTS = 5;

router.use(protect);

function toObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

function uniqueIds(ids) {
  return [...new Set(ids.map((id) => id.toString()))];
}

function userSummary(user) {
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

function planSummary(plan) {
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

function formatDateTimeLabel(dateValue) {
  return new Intl.DateTimeFormat('en-NZ', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(dateValue));
}

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

function parseSuggestionInput(body) {
  const dateFrom = body.dateFrom ? new Date(body.dateFrom) : new Date();
  const dateTo = body.dateTo ? new Date(body.dateTo) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const durationMinutes = Number(body.durationMinutes || 120);
  const participantIds = Array.isArray(body.participantIds) ? body.participantIds : [];
  const activityType = String(body.activityType || 'food').trim() || 'food';

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

  return {
    dateFrom,
    dateTo,
    durationMinutes,
    activityType,
    participantIds,
  };
}

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

function placesTypesForActivity(activityType) {
  const typeMap = {
    coffee: ['cafe'],
    food: ['restaurant', 'cafe'],
    activity: ['bowling_alley', 'movie_theater', 'amusement_center'],
    outdoors: ['park', 'tourist_attraction'],
  };

  return typeMap[activityType] ?? typeMap.food;
}

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
      maxResultCount: 5,
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

  return places.map((place) => ({
    name: place.displayName?.text ?? 'Suggested place',
    address: place.formattedAddress ?? '',
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rating: place.rating,
    googleMapsUri: place.googleMapsUri,
  }));
}

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

router.get('/friends', async (req, res) => {
  try {
    console.log('GET /suggestions/friends', { userId: req.user.userId });

    const currentUserId = toObjectId(req.user.userId);
    const friendships = await Friendship.find({
      status: 'accepted',
      $or: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
    }).populate(['requesterId', 'receiverId']);

    const friends = friendships
      .map((friendship) => {
        const requesterId = friendship.requesterId._id.toString();
        return requesterId === req.user.userId ? friendship.receiverId : friendship.requesterId;
      })
      .map(userSummary);

    res.json({ friends });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.post('/hangout', async (req, res) => {
  try {
    console.log('POST /suggestions/hangout', {
      userId: req.user.userId,
      participantCount: Array.isArray(req.body.participantIds) ? req.body.participantIds.length : 0,
      activityType: req.body.activityType,
    });

    const input = parseSuggestionInput(req.body);
    const users = await loadSuggestionUsers(req.user.userId, input.participantIds);
    const [calendarResults, places] = await Promise.all([
      Promise.all(users.map((user) => fetchBusyBlocks(user, input.dateFrom, input.dateTo))),
      fetchPlaceSuggestions({ users, activityType: input.activityType }),
    ]);
    const slots = findCommonFreeSlots(
      calendarResults,
      input.dateFrom,
      input.dateTo,
      input.durationMinutes
    );

    const suggestions = slots.map((slot, index) => ({
      id: `suggestion-${index + 1}`,
      time: slot,
      place: places[index % places.length],
      participants: users.map(userSummary),
      score: Math.max(70, 96 - index * 7),
    }));

    res.json({
      suggestions,
      calendarStatus: calendarResults.map((calendar) => ({
        userId: calendar.userId,
        calendarConnected: calendar.calendarConnected,
        calendarError: calendar.calendarError,
      })),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.post('/plans', async (req, res) => {
  try {
    console.log('POST /suggestions/plans', {
      userId: req.user.userId,
      participantCount: Array.isArray(req.body.participantIds) ? req.body.participantIds.length : 0,
      title: req.body.title,
    });

    const participantIds = Array.isArray(req.body.participantIds) ? req.body.participantIds : [];
    const users = await loadSuggestionUsers(req.user.userId, participantIds);
    const startsAt = new Date(req.body.startsAt);
    const endsAt = new Date(req.body.endsAt);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return res.status(400).json({ message: 'Valid plan start and end time are required.' });
    }

    const creatorObjectId = toObjectId(req.user.userId);
    const invitedObjectIds = users
      .filter((user) => user._id.toString() !== req.user.userId)
      .map((user) => user._id);
    const place = req.body.place ?? {};
    const title = String(req.body.title || `${place.name || 'Hangout'} plan`).trim();
    const plan = await Plan.create({
      title,
      creatorId: req.user.userId,
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
      activityType: req.body.activityType || 'food',
      status: 'pending',
    });

    const populatedPlan = await Plan.findById(plan._id).populate(['participantIds', 'creatorId']);

    res.status(201).json({
      plan: planSummary(populatedPlan),
      invitedCount: invitedObjectIds.length,
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.get('/plan-invites', async (req, res) => {
  try {
    console.log('GET /suggestions/plan-invites', { userId: req.user.userId });

    const plans = await Plan.find({
      invitedParticipantIds: req.user.userId,
      acceptedParticipantIds: { $ne: req.user.userId },
      status: { $ne: 'cancelled' },
      endsAt: { $gt: new Date() },
    })
      .populate('creatorId')
      .sort({ startsAt: 1 });

    res.json({ invites: plans.map(planInviteSummary) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.post('/plans/:id/accept', async (req, res) => {
  try {
    console.log('POST /suggestions/plans/:id/accept', {
      userId: req.user.userId,
      planId: req.params.id,
    });

    const plan = await Plan.findOne({
      _id: req.params.id,
      invitedParticipantIds: req.user.userId,
      status: { $ne: 'cancelled' },
    });

    if (!plan) {
      return res.status(404).json({ message: 'Plan invite not found.' });
    }

    const currentUserId = toObjectId(req.user.userId);
    const participantIds = uniqueIds([...plan.participantIds, currentUserId]).map(toObjectId);
    const acceptedParticipantIds = uniqueIds([...plan.acceptedParticipantIds, currentUserId]).map(toObjectId);

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
      senderId: req.user.userId,
      content: `Accepted plan invite: ${plan.title}`,
      readBy: [req.user.userId],
    });

    const populatedPlan = await Plan.findById(plan._id).populate(['participantIds', 'creatorId']);

    res.json({
      plan: planSummary(populatedPlan),
      conversationId: conversation._id.toString(),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.get('/plans', async (req, res) => {
  try {
    console.log('GET /suggestions/plans', { userId: req.user.userId });

    const plans = await Plan.find({
      participantIds: req.user.userId,
      status: { $in: ['pending', 'confirmed'] },
      endsAt: { $gt: new Date() },
    })
      .populate(['participantIds', 'creatorId'])
      .sort({ startsAt: 1 });

    res.json({ plans: plans.map(planSummary) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

router.patch('/plans/:id/cancel', async (req, res) => {
  try {
    console.log('PATCH /suggestions/plans/:id/cancel', {
      userId: req.user.userId,
      planId: req.params.id,
    });

    const plan = await Plan.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [
          { creatorId: req.user.userId },
          { participantIds: req.user.userId },
          { invitedParticipantIds: req.user.userId },
        ],
        status: { $ne: 'cancelled' },
      },
      { $set: { status: 'cancelled' } },
      { new: true }
    ).populate(['participantIds', 'creatorId']);

    if (!plan) {
      return res.status(404).json({ message: 'Plan not found.' });
    }

    res.json({ plan: planSummary(plan) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
});

export default router;
