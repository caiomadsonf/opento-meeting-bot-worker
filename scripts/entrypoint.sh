#!/bin/sh
set -e

mkdir -p /data/chrome-profile /data/recordings /tmp/runtime-root

export XDG_RUNTIME_DIR=/tmp/runtime-root
export DISPLAY=${DISPLAY:-:99}

echo "Starting Xvfb on ${DISPLAY}..."
Xvfb ${DISPLAY} -screen 0 1440x900x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 &

sleep 2

echo "Starting PulseAudio..."
pulseaudio --start --exit-idle-time=-1 --log-target=stderr || true
sleep 2

echo "Creating PulseAudio virtual sink..."
pactl load-module module-null-sink sink_name=meet_sink sink_properties=device.description=MeetSink || true
pactl set-default-sink meet_sink || true
pactl set-default-source meet_sink.monitor || true

echo "PulseAudio sinks:"
pactl list short sinks || true

echo "PulseAudio sources:"
pactl list short sources || true

echo "Chrome version:"
/usr/bin/google-chrome-stable --version || true





echo "Preparing bot camera video..."

BOT_CAMERA_SELECTED=""

if [ -n "${BOT_CAMERA_VIDEO}" ] && [ -f "${BOT_CAMERA_VIDEO}" ]; then
  BOT_CAMERA_SELECTED="${BOT_CAMERA_VIDEO}"
  echo "Found primary BOT_CAMERA_VIDEO: ${BOT_CAMERA_SELECTED}"
elif [ -n "${BOT_CAMERA_VIDEO_FALLBACK}" ] && [ -f "${BOT_CAMERA_VIDEO_FALLBACK}" ]; then
  BOT_CAMERA_SELECTED="${BOT_CAMERA_VIDEO_FALLBACK}"
  echo "Found fallback BOT_CAMERA_VIDEO_FALLBACK: ${BOT_CAMERA_SELECTED}"
else
  echo "No custom bot camera MP4 found."
fi

mkdir -p "$(dirname "${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}")"
mkdir -p /data/assets

if [ -n "${BOT_CAMERA_SELECTED}" ]; then
  echo "Converting custom camera video to Y4M..."
  ffmpeg -y -stream_loop -1 -i "${BOT_CAMERA_SELECTED}" \
    -t 15 \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
    "${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}" >/tmp/bot-camera-convert.log 2>&1 || {
      echo "Failed to convert custom camera video. See /tmp/bot-camera-convert.log"
      cat /tmp/bot-camera-convert.log || true
    }
elif [ "${BOT_CAMERA_GENERATE_FALLBACK:-true}" = "true" ]; then
  echo "Generating fallback OpenTo AI REC camera video..."
  FALLBACK_MP4="/data/assets/opento-bot-rec-fallback.mp4"

  ffmpeg -y \
    -f lavfi -i "color=c=0b0712:s=1280x720:d=15:r=30" \
    -vf "drawbox=x=0:y=0:w=1280:h=720:color=0x7c3aed@0.08:t=fill,drawbox=x=80:y=80:w=1120:h=560:color=0xffffff@0.04:t=2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='OpenTo AI':fontcolor=white:fontsize=78:x=(w-text_w)/2:y=260,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Gravando reunião':fontcolor=0xd8b4fe:fontsize=38:x=(w-text_w)/2:y=360,drawbox=x=506:y=445:w=268:h=72:color=0xef4444@0.95:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='REC':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=457" \
    -an -c:v libx264 -pix_fmt yuv420p "${FALLBACK_MP4}" >/tmp/bot-camera-fallback.log 2>&1 || {
      echo "Failed to generate fallback MP4."
      cat /tmp/bot-camera-fallback.log || true
    }

  if [ -f "${FALLBACK_MP4}" ]; then
    ffmpeg -y -stream_loop -1 -i "${FALLBACK_MP4}" \
      -t 15 \
      -vf "scale=1280:720,fps=30,format=yuv420p" \
      "${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}" >/tmp/bot-camera-convert.log 2>&1 || {
        echo "Failed to convert fallback camera video."
        cat /tmp/bot-camera-convert.log || true
      }
  fi
fi

if [ -f "${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}" ]; then
  echo "Camera Y4M ready: ${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}"
  ls -lh "${BOT_CAMERA_Y4M:-/data/opento-bot-rec.y4m}" || true
else
  echo "Camera Y4M not ready. Chrome will use default camera behavior."
fi


echo "Starting Node server..."
exec npm start
