'use strict';
// Fixture bridge client: answers core requests, turning a thrown error into an error reply.
const net = require('net');

class BridgeClient {
  constructor(o) {
    this.onRequest = o.onRequest;
    this.socket = null;
  }

  connect(socketPath) {
    this.socket = net.createConnection(socketPath);
  }

  async _handleRequest(msg) {
    let reply;
    try {
      const result = await this.onRequest(msg.op, msg.params, msg);
      reply = { t: 'reply', id: msg.id, result: result === undefined ? {} : result };
    } catch (e) {
      reply = { t: 'reply', id: msg.id, error: { message: String((e && e.message) || e) } };
    }
    this.send(reply);
  }

  send(obj) {
    if (this.socket) this.socket.write(JSON.stringify(obj) + '\n');
  }
}

module.exports = { BridgeClient };
