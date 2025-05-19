//no version control error 😂😂😂😂 started from index.js    ->    server.js  ->  new.js

const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");
require("dotenv").config();

// Setup
const app = express();
app.use(express.json());
const PORT = 3000;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// MongoDB schema
const userSchema = new mongoose.Schema({
  email: String,
  count: Number,
  start_time: Date,
  end_time: Date,
  session_history: [Date],
  last_template_sent: String,
  last_template_sent_at: Date,
});
const User = mongoose.model("User", userSchema);

function shouldSendTemplate(user, templateName, cooldownDays = 14) {
  if (user.last_template_sent !== templateName) return true;

  if (!user.last_template_sent_at) return true;

  const now = new Date();
  const lastSent = new Date(user.last_template_sent_at);
  const diffDays = (now - lastSent) / (1000 * 60 * 60 * 24);

  return diffDays >= cooldownDays;
}

// Email sending function
function sendEmail(recipients, templateName) {
  const templateIdMap = {
    "Template A": "TEMPLATE_ID_A",
    "Template B": "TEMPLATE_ID_B",
    "Template X": "TEMPLATE_ID_X",
    Dormant: "d-2ea617fd7b66416ea0271d98d1817335",
    Resurrecting: "d-1936f4647fd04108a9d69300638a258d",
    Returning: "d-703d31c2291a43b5ab096182d9011bd6",
  };

  const messages = recipients.map((email) => ({
    to: email,
    from: "info@on-demand.io",
    templateId: templateIdMap[templateName],
    dynamicTemplateData: { name: email.split("@")[0] },
  }));

  return sgMail.send(messages);
}

// Fetch PostHog data
const API_KEY = "phx_NPB9hVJVoijX72qCyJYi3azMQ59E87ZD7F25gNuvAhTXcC5";
const BASE_URL =
  "https://us.posthog.com/api/projects/128173/session_recordings/";
const LIMIT = 500;

async function fetchSessionRecordings() {
  let allRecordings = [];
  let nextUrl = `${BASE_URL}?limit=${LIMIT}`;

  while (nextUrl) {
    try {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      allRecordings = allRecordings.concat(response.data.results);
      nextUrl = response.data.next;
    } catch (err) {
      console.error("Error fetching from PostHog:", err.message);
      break;
    }
  }
  return allRecordings;
}

// Classify user based on inactivity
function classifyUser(user) {
  const now = new Date();
  const periodLengthDays = 7;
  const inactiveThresholdDays = 14;

  const sessions = user.session_history;
  const cutoffP0 = new Date(now - periodLengthDays * 24 * 60 * 60 * 1000);
  const cutoffP1 = new Date(now - 2 * periodLengthDays * 24 * 60 * 60 * 1000);
  const inactiveCutoff = new Date(
    now - inactiveThresholdDays * 24 * 60 * 60 * 1000
  );

  const sortedSessions = sessions.sort((a, b) => new Date(a) - new Date(b));
  const lastSession = sortedSessions[sortedSessions.length - 1];

  if (sortedSessions.length <= 1) {
    return null;
  }

  if (lastSession <= inactiveCutoff) {
    return "Dormant";
  }

  const P0 = sortedSessions.filter((date) => date > cutoffP0);
  const P1 = sortedSessions.filter(
    (date) => date <= cutoffP0 && date > cutoffP1
  );

  if (P0.length > 0 && P1.length === 0) {
    const accountAgeDays =
      (now - new Date(user.start_time)) / (1000 * 60 * 60 * 24);
    if (accountAgeDays >= 14) {
      return "Resurrecting";
    }
  }

  if (P0.length > 0 && P1.length > 0) {
    return "Returning";
  }

  return null;
}

// Main sync route
app.get("/sync", async (req, res) => {
  const recordings = await fetchSessionRecordings();
  const emailBuckets = {
    "Template A": [],
    "Template B": [],
    "Template X": [],
    Dormant: [],
    Resurrecting: [],
    Returning: [],
  };

  // Step 1: Update session data from PostHog
  for (const rec of recordings) {
    const email = rec.person?.properties?.email;
    if (!email) continue;

    const end_time = new Date(rec.end_time || Date.now());
    const start_time = new Date(rec.start_time || Date.now());

    await User.findOneAndUpdate(
      { email },
      {
        $setOnInsert: {
          start_time,
          last_template_sent: null,
        },
        $max: { end_time: end_time },
        $inc: { count: 1 },
        $addToSet: { session_history: end_time },
      },
      { upsert: true, new: true }
    );
    
  }

  // Step 2: Classify and prepare emails
  const allUsers = await User.find();

  for (const user of allUsers) {
    const email = user.email;
    const updates = {};
    const now = new Date();
  
    if (
      user.count >= 1000 &&
      user.last_template_sent === "Template B" &&
      shouldSendTemplate(user, "Template X")
    ) {
      emailBuckets["Template X"].push(email);
      updates.last_template_sent = "Template X";
      updates.last_template_sent_at = now;
    } else if (
      user.count >= 500 &&
      user.last_template_sent === "Template A" &&
      shouldSendTemplate(user, "Template B")
    ) {
      emailBuckets["Template B"].push(email);
      updates.last_template_sent = "Template B";
      updates.last_template_sent_at = now;
    } else if (user.count >= 200 && shouldSendTemplate(user, "Template A")) {
      emailBuckets["Template A"].push(email);
      updates.last_template_sent = "Template A";
      updates.last_template_sent_at = now;
    }
  
    const segment = classifyUser(user);
    if (segment && shouldSendTemplate(user, segment)) {
      emailBuckets[segment].push(email);
      updates.last_template_sent = segment;
      updates.last_template_sent_at = now;
    }
  
    if (Object.keys(updates).length > 0) {
      await User.updateOne({ _id: user._id }, { $set: updates });
    }
  }
  




  // Log the number of users in each bucket// Check if any emails need to be sent
  let totalEmailsToSend = 0;
  for (const template in emailBuckets) {
    totalEmailsToSend += emailBuckets[template].length;
  }

  if (totalEmailsToSend === 0) {
    return res.status(200).send("✅ No emails needed to be sent.");
  }




  // Step 3: Send emails
  for (const [template, emails] of Object.entries(emailBuckets)) {
    if (emails.length > 0) {
      try {
        await sendEmail(emails, template);
        console.log(`✅ Sent ${template} to ${emails.length} users`);
      } catch (e) {
        console.error(`❌ Error sending ${template} emails:`, e.message);
      }
    }
  }

  res.json({
    success: true,
    message: "Session data synced and emails triggered.",
  });
});

// DB and start server
mongoose
  .connect(
    "mongodb+srv://Damandeep:MongoDB@cluster0.9j661l9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
  )
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("MongoDB error:", err));
