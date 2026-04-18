export function parseSseFrames(buffer, { flush = false } = {}) {
  const chunks = String(buffer || '').split('\n\n');
  const remainder = flush ? '' : (chunks.pop() || '');
  const frames = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    const lines = chunk.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) || 'message';
    const dataLines = lines
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    if (!dataLines.length) continue;

    try {
      frames.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      // Ignore malformed/incomplete frame and continue.
    }
  }

  return { frames, remainder };
}

/**
 * Consume a ReadableStream of SSE chunks and dispatch parsed frames.
 * `onFrame` may return false to stop consuming early.
 */
export async function streamSseFrames(readableStream, onFrame) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let shouldContinue = true;

  while (shouldContinue) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      const { frames } = parseSseFrames(buffer, { flush: true });
      for (const frame of frames) {
        const result = await onFrame(frame);
        if (result === false) {
          shouldContinue = false;
          break;
        }
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.remainder;
    for (const frame of parsed.frames) {
      const result = await onFrame(frame);
      if (result === false) {
        shouldContinue = false;
        break;
      }
    }
  }

  if (!shouldContinue) {
    try { await reader.cancel(); } catch { /* noop */ }
  }
}
