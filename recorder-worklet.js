/**
 * recorder-worklet.js — AudioWorkletProcessor pour capture PCM brut
 * Corrections v7.6.172:
 * - Envoi des buffers silencieux pour continuité temporelle (pas de trous PCM)
 * - postMessage avec transferable buffer — évite la copie mémoire
 * - Mixage stéréo → mono avant envoi
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false;
    };
  }

  process(inputs) {
    if (!this._active) return false;
    const input = inputs[0];
    // Toujours envoyer 128 samples — même silence — pour continuité temporelle
    const size = 128;
    const buf = new Float32Array(size);
    if (input && input.length > 0) {
      const L = input[0];
      const R = input[1]; // peut être undefined si mono
      if (L && L.length > 0) {
        if (R && R.length > 0) {
          // Mixage stéréo → mono (moyenne L+R)
          for (let i = 0; i < size; i++) buf[i] = (L[i] + R[i]) * 0.5;
        } else {
          buf.set(L.subarray(0, size));
        }
      }
      // Si input vide → buf reste à 0 (silence) — continuité maintenue
    }
    // Transferable: zéro copie mémoire — performance optimale
    this.port.postMessage(buf.buffer, [buf.buffer]);
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
