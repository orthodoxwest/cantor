// Runs in the page, before its scripts: cantor.wasm traps for real on the fourth chunk it is
// asked to sing, by being asked for more samples than it can hold, as a renderer out of memory
// would. Other modules are left alone.
export function trapFourthChunk() {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  let calls = 0;
  WebAssembly.instantiate = async (...args) => {
    const result = await instantiate(...args);
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const real = instance.exports;
    if (!("cantor_sing" in real)) return result;
    const exports = {
      ...real,
      cantor_sing: (voice, part, rate, from, len) => real.cantor_sing(voice, part, rate, from, ++calls === 4 ? 0x7fffffff : len),
    };
    return result instanceof WebAssembly.Instance ? { exports } : { ...result, instance: { exports } };
  };
}
