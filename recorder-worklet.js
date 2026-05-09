/**
 * recorder-worklet.js — AudioWorkletProcessor pour capture PCM brut
 * Tourne dans un thread temps-réel isolé — iOS ne peut pas interférer.
 * Envoie des Float32Array au thread principal via port.postMessage.
 * 
 * À placer dans /public/recorder-worklet.js (servi comme fichier statique).
 * NE PAS bundler avec React — doit être accessible via URL directe.
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
    if (input && input[0] && input[0].length > 0) {
      // Copie du buffer Float32 — évite les problèmes de transfert mémoire
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keepAlive
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
