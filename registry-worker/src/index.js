// The Worker: every request goes to the one Registry Durable Object, which is the single writer of the event log.
export { Registry } from './registry.js';

export default {
  async fetch(request, env) {
    const stub = env.REGISTRY.get(env.REGISTRY.idFromName('main'));
    return stub.fetch(request);
  },
};
