const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');
const fs = require('fs');
require('dotenv').config();


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
const User = mongoose.model('User', userSchema);

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
    'Template A': 'TEMPLATE_ID_A',
    'Template B': 'TEMPLATE_ID_B',
    'Template X': 'TEMPLATE_ID_X',
    'Dormant': 'd-e4bf3d674cda4eca930d1faf6047c20e',
    'Resurrecting': 'd-03b46f16cd9f40a894221358391e9918',
    'Returning': 'd-c925f77f038f49f08b9f59106c459c67',
  };

  const messages = recipients.map(email => ({
    to: email,
    from: 'info@on-demand.io',
    templateId: templateIdMap[templateName],
    dynamicTemplateData: { name: email.split('@')[0] },
  }));

  return sgMail.send(messages);
}

// Fetch PostHog data
const API_KEY = 'phx_NPB9hVJVoijX72qCyJYi3azMQ59E87ZD7F25gNuvAhTXcC5';
const BASE_URL = 'https://us.posthog.com/api/projects/128173/session_recordings/';
const LIMIT = 2000;

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
      console.error('Error fetching from PostHog:', err.message);
      break;
    }
  }
  return allRecordings;
}

// Classify user based on inactivity
function classifyUser(sessions) {
    const now = new Date();
    const periodLengthDays = 7;
    const inactiveThresholdDays = 14;
  
    const cutoffP0 = new Date(now - periodLengthDays * 24 * 60 * 60 * 1000);       // 7 days ago
    const cutoffP1 = new Date(now - 2 * periodLengthDays * 24 * 60 * 60 * 1000);   // 14 days ago
    const inactiveCutoff = new Date(now - inactiveThresholdDays * 24 * 60 * 60 * 1000); // 14 days ago
  
    const sortedSessions = sessions.sort((a, b) => new Date(a) - new Date(b));
    const lastSession = sortedSessions[sortedSessions.length - 1];
  
    // 🧼 Ignore first-time or one-time users for lifecycle templates
    if (sortedSessions.length <= 1) {
      return null;
    }
  
    if (lastSession <= inactiveCutoff) {
      return 'Dormant';
    }
  
    const P0 = sortedSessions.filter(date => date > cutoffP0);
    const P1 = sortedSessions.filter(date => date <= cutoffP0 && date > cutoffP1);
  
    if (P0.length > 0 && P1.length === 0) {
      return 'Resurrecting';
    }
  
    if (P0.length > 0 && P1.length > 0) {
      return 'Returning';
    }
  
    return null;
  }
  
  
  

// Main sync route
app.get('/sync', async (req, res) => {
    const recordings = await fetchSessionRecordings();
    const emailBuckets = {
      'Template A': [],
      'Template B': [],
      'Template X': [],
      'Dormant': [],
      'Resurrecting': [],
      'Returning': [],
    };
  
    // Step 1: Update session data from PostHog
    for (const rec of recordings) {
      const email = rec.person?.properties?.email;
      if (!email) continue;
  
      const end_time = new Date(rec.end_time || Date.now());
      const start_time = new Date(rec.start_time || Date.now());
  
      let user = await User.findOne({ email });
      if (!user) {
        user = await User.create({
          email,
          start_time,
          end_time,
          count: 1,
          session_history: [end_time],
          last_template_sent: null,
        });
      } else if (end_time > user.end_time) {
        user.end_time = end_time;
        user.count += 1;
        // Add check to avoid duplicates
        if (!user.session_history.some(session => session.getTime() === end_time.getTime())) {
          user.session_history.push(end_time);
        }
        await user.save();
      }
      
    }
  
    // Step 2: Classify and prepare emails
    const allUsers = await User.find();
  
    for (const user of allUsers) {
      const email = user.email;
  
      // Progression-based templates
      if (user.count >= 1000 && user.last_template_sent === 'Template B' && shouldSendTemplate(user, 'Template X')) {
        emailBuckets['Template X'].push(email);
        user.last_template_sent = 'Template X';
        user.last_template_sent_at = new Date();
      } else if (user.count >= 500 && user.last_template_sent === 'Template A' && shouldSendTemplate(user, 'Template B')) {
        emailBuckets['Template B'].push(email);
        user.last_template_sent = 'Template B';
        user.last_template_sent_at = new Date();
      } else if (user.count >= 200 && shouldSendTemplate(user, 'Template A')) {
        emailBuckets['Template A'].push(email);
        user.last_template_sent = 'Template A';
        user.last_template_sent_at = new Date();
      }
  
      // Inactivity classification
      const classification = classifyUser(user.session_history.sort((a, b) => a - b));
      if (classification && shouldSendTemplate(user, classification)) {
        emailBuckets[classification].push(email);
        user.last_template_sent = classification;
        user.last_template_sent_at = new Date();
      }
  
      await user.save();
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
  
    res.json({ success: true, message: 'Session data synced and emails triggered.' });
  });
  
  

// DB and start server
mongoose
  .connect('mongodb+srv://Damandeep:MongoDB@cluster0.9j661l9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch(err => console.error('MongoDB error:', err));
