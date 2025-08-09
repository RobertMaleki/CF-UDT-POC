# Outbound AI Call Center Agent – Crunch Fitness POC

## Overview
This Proof of Concept (POC) demonstrates an **AI-powered outbound call center agent** for lead nurturing and conversion optimization for Crunch Fitness.

**Flow:**
1. A user enters their information in a demo web form.
2. The system automatically places an outbound call to the user using Twilio.
3. The AI agent engages in real-time conversation (via OpenAI Realtime API) with the goal of booking a trial pass at Crunch Fitness.

---

## Tech Stack
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js + Express
- **Telephony:** Twilio Programmable Voice
- **AI Conversation:** OpenAI Realtime API (`gpt-4o-realtime-preview`)
- **Speech Processing:** STT & TTS via OpenAI
- **Data Storage:** (Optional) Google Sheets API for lead logging

---

## Setup Instructions

### 1. Clone the Repository
```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME
