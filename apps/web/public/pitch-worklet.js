// Arai pitch shifter (AudioWorklet). Transposes without changing speed using
// two crossfaded read heads sweeping through a short delay line (a classic
// granular "delay-modulation" shifter). Equal-power sine windows keep the
// level steady. At ratio 1 it is an exact bypass.
const W = 2048; // grain length in samples (~46 ms at 44.1 kHz)
const N = 8192;

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.buf = [];
    this.w = 0;
    this.d = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const ratio = params.ratio[0];
    if (!input || input.length === 0) return true;
    while (this.buf.length < input.length) this.buf.push(new Float32Array(N));
    const frames = input[0].length;
    if (Math.abs(ratio - 1) < 1e-4) {
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      return true;
    }
    const step = 1 - ratio;
    for (let i = 0; i < frames; i++) {
      let d1 = this.d;
      let d2 = d1 + W / 2;
      if (d2 >= W) d2 -= W;
      const g1 = Math.sin((Math.PI * d1) / W);
      const g2 = Math.sin((Math.PI * d2) / W);
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)];
        const b = this.buf[c] ?? this.buf[0];
        b[this.w] = src[i];
        const read = (d) => {
          const p = this.w - d - 1 + N * 2;
          const i0 = Math.floor(p) % N;
          const f = p - Math.floor(p);
          return b[i0] * (1 - f) + b[(i0 + 1) % N] * f;
        };
        output[c][i] = g1 * read(d1) + g2 * read(d2);
      }
      this.w = (this.w + 1) % N;
      this.d += step;
      if (this.d >= W) this.d -= W;
      else if (this.d < 0) this.d += W;
    }
    return true;
  }
}
registerProcessor('arai-pitch-shifter', PitchShifter);
