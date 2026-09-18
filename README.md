# AI Voice Agent — Backend

Node.js service for Twilio ConversationRelay, Gemini, MongoDB, and dashboard APIs.

## Quick start

```bash
cp .env.example .env
# fill in Twilio + Gemini credentials and public WSS URL
npm install
npm run dev
```

Health check: `GET http://localhost:3000/health`
