import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { BrowserWindow } from 'electron';
import { WebSocketServer } from 'ws';

import { logger } from '@main/logger';

const CAPTURE_HTML = `<!doctype html>
<html>
  <body>
    <script>
      const resampleTo16k = (input, fromRate) => {
        if (fromRate === 16000) return input;
        const ratio = fromRate / 16000;
        const length = Math.floor(input.length / ratio);
        const output = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          const position = i * ratio;
          const left = Math.floor(position);
          const right = Math.min(left + 1, input.length - 1);
          const fraction = position - left;
          output[i] = input[left] * (1 - fraction) + input[right] * fraction;
        }
        return output;
      };
      const floatToInt16 = (input) => {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        return output;
      };
      (async () => {
        const ws = new WebSocket('ws://127.0.0.1:' + location.port + '/ws');
        const sendReady = (label) =>
          ws.send(JSON.stringify({ type: 'ready', label }));
        const sendError = (message) =>
          ws.send(JSON.stringify({ type: 'error', message }));
        ws.onopen = async () => {
          try {
            const warm = await navigator.mediaDevices.getUserMedia({ audio: true });
            warm.getTracks().forEach((track) => track.stop());
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter((device) => device.kind === 'audioinput');
            const physical = inputs.find(
              (device) =>
                device.deviceId &&
                device.deviceId !== 'default' &&
                device.deviceId !== 'communications' &&
                device.label &&
                !/todesk|virtual|stereo mix|line in/i.test(device.label),
            );
            if (!physical) {
              sendError('No physical microphone found. Connect the headset microphone and restart voice.');
              return;
            }
            const ec =
              new URLSearchParams(location.search).get('ec') === '1';
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: physical.deviceId },
                channelCount: 1,
                echoCancellation: ec,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            const track = stream.getAudioTracks()[0];
            const label = track && track.label;
            track?.addEventListener('ended', () => {
              sendError('Microphone disconnected');
            });
            sendReady(label || physical.label);
            const context = new AudioContext();
            await context.resume();
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(1024, 1, 1);
            const pending = [];
            processor.onaudioprocess = (event) => {
              const samples = resampleTo16k(
                event.inputBuffer.getChannelData(0),
                context.sampleRate,
              );
              for (let i = 0; i < samples.length; i += 1) pending.push(samples[i]);
              while (pending.length >= 320) {
                const chunk = floatToInt16(Float32Array.from(pending.splice(0, 320)));
                if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer);
              }
            };
            const mute = context.createGain();
            mute.gain.value = 0;
            source.connect(processor);
            processor.connect(mute);
            mute.connect(context.destination);
          } catch (error) {
            sendError(error && error.message ? error.message : String(error));
          }
        };
      })();
    </script>
  </body>
</html>`;

export interface CaptureServiceHandlers {
  onPcm: (pcm16: Int16Array) => void;
  onReady: (label: string) => void;
  onError: (message: string) => void;
}

export interface CaptureService {
  close: () => void;
}

export interface CaptureServiceOptions {
  echoCancellation: boolean;
}

/**
 * Hidden renderer that only captures the microphone. Playback stays in the
 * main window; separating capture from playback avoids Chrome's AEC
 * silencing the mic while the assistant speaks.
 */
export const startCaptureService = async (
  handlers: CaptureServiceHandlers,
  options: CaptureServiceOptions,
): Promise<CaptureService> => {
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/capture')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(CAPTURE_HTML);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  wss.on('connection', (socket) => {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const buffer = Buffer.from(data);
        if (buffer.byteLength >= 2) {
          handlers.onPcm(
            new Int16Array(
              buffer.buffer,
              buffer.byteOffset,
              Math.floor(buffer.byteLength / 2),
            ),
          );
        }
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          label?: string;
          message?: string;
        };
        if (message.type === 'ready') {
          handlers.onReady(message.label || 'external microphone');
        } else if (message.type === 'error') {
          handlers.onError(message.message || 'capture error');
        }
      } catch (error) {
        logger.warn('[cyrvis capture] bad control message', error);
      }
    });
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
    },
  });
  await window.loadURL(
    `http://127.0.0.1:${port}/capture?ec=${options.echoCancellation ? '1' : '0'}`,
  );
  logger.info('[cyrvis capture] hidden capture window started', {
    port,
    echoCancellation: options.echoCancellation,
  });

  return {
    close: () => {
      try {
        window.destroy();
      } catch {
        // already destroyed
      }
      wss.close();
      server.close();
    },
  };
};
