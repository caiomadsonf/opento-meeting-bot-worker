# OpenTo Meeting Bot Worker - Login Recorder V4.10.2

Versão corrigida após erro de syntax da v4.10.1.

Base:
- v4.9 estável

Correção aplicada com segurança:
- Depois que o bot é aceito na reunião, ainda dentro do fluxo async do /join:
  1. força microfone OFF
  2. força câmera ON
  3. aguarda estabilizar
  4. inicia FFmpeg

Mantém:
- fallback automático de vídeo OpenTo AI / REC
- geração de /data/opento-bot-rec.y4m
- gravação de áudio
- saída automática
- callback para histórico/resumo

ENV recomendado:
NODE_ENV=production
WORKER_TOKEN=opento_bot_2026_8f93ks92kLm2pQx77zA
BOT_NAME=OpenTo AI - Gravando
CHROME_PROFILE_DIR=/data/chrome-profile
RECORDINGS_DIR=/data/recordings
MAX_RECORD_SECONDS=30
ADMISSION_WAIT_MS=45000
ADMISSION_POLL_MS=1500
JOIN_SETTLE_MS=1800
POST_JOIN_CLICK_WAIT_MS=1200
PULSE_SOURCE=meet_sink.monitor
REUSE_REMOTE_BROWSER=true
STRICT_ADMISSION=true
AUTO_LEAVE_AFTER_RECORDING=true
BOT_CAMERA_VIDEO=/app/assets/opento-bot-rec.mp4
BOT_CAMERA_VIDEO_FALLBACK=/data/assets/opento-bot-rec.mp4
BOT_CAMERA_Y4M=/data/opento-bot-rec.y4m
BOT_CAMERA_GENERATE_FALLBACK=true

No /health:
mode deve conter v4.10.2.
