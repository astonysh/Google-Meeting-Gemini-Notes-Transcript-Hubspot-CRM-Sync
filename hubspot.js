'use strict';

const axios = require('axios');

const BASE = 'https://api.hubapi.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function findMeetingsByTimeWindow(startTimeMs, windowMin = 10) {
  const windowMs = windowMin * 60 * 1000;
  const res = await axios.post(
    `${BASE}/crm/v3/objects/meetings/search`,
    {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: startTimeMs - windowMs },
            { propertyName: 'hs_meeting_start_time', operator: 'LTE', value: startTimeMs + windowMs },
          ],
        },
      ],
      properties: ['hs_meeting_title', 'hs_meeting_start_time'],
      limit: 10,
    },
    { headers: headers() }
  );
  return (res.data.results || []).map((r) => ({
    id: r.id,
    title: r.properties.hs_meeting_title,
    startTime: r.properties.hs_meeting_start_time,
  }));
}

/**
 * Updates the meeting body using the v1 Engagements API.
 *
 * IMPORTANT: HubSpot meetings may be linked to Google Calendar. Updating the
 * meeting body here will also update the Google Calendar event description,
 * which causes Google to automatically send an "event updated" notification
 * email to all meeting attendees. This is standard Google Calendar behavior
 * and cannot be suppressed from the HubSpot API side.
 */
async function updateMeetingBody(meetingId, bodyHtml) {
  await axios.patch(
    `${BASE}/engagements/v1/engagements/${meetingId}`,
    { metadata: { body: bodyHtml } },
    { headers: headers() }
  );
}

module.exports = { findMeetingsByTimeWindow, updateMeetingBody };
