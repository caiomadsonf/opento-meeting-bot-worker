FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg xvfb pulseaudio pulseaudio-utils fonts-liberation fonts-noto-color-emoji \
    ca-certificates dumb-init wget gnupg xdg-utils procps --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x /app/scripts/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=80
ENV DISPLAY=:99
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV CHROME_PROFILE_DIR=/data/chrome-profile
ENV RECORDINGS_DIR=/data/recordings
ENV MAX_RECORD_SECONDS=30
ENV ADMISSION_WAIT_MS=45000
ENV REUSE_REMOTE_BROWSER=true
ENV STRICT_ADMISSION=true
ENV AUTO_LEAVE_AFTER_RECORDING=true
ENV ADMISSION_POLL_MS=1500
ENV JOIN_SETTLE_MS=1800
ENV POST_JOIN_CLICK_WAIT_MS=1200
ENV PULSE_SOURCE=meet_sink.monitor
ENV BOT_CAMERA_VIDEO=/app/assets/opento-bot-rec.mp4
ENV BOT_CAMERA_Y4M=/data/opento-bot-rec.y4m

EXPOSE 80
ENTRYPOINT ["dumb-init", "--", "/app/scripts/entrypoint.sh"]

ENV BOT_CAMERA_VIDEO_FALLBACK=/data/assets/opento-bot-rec.mp4

ENV BOT_CAMERA_GENERATE_FALLBACK=true
