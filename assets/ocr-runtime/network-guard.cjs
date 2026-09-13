"use strict";

const blocked = () => {
  throw new Error("AGENT_CALLOUT_OCR_NETWORK_DISABLED");
};

const blockMethods = (module, names) => {
  for (const name of names) {
    if (typeof module[name] === "function") module[name] = blocked;
  }
};

globalThis.fetch = async () => blocked();

for (const moduleName of ["node:http", "node:https"]) {
  const module = require(moduleName);
  blockMethods(module, ["request", "get"]);
}

const net = require("node:net");
blockMethods(net, ["connect", "createConnection"]);
if (net.Socket?.prototype) net.Socket.prototype.connect = blocked;

const tls = require("node:tls");
blockMethods(tls, ["connect"]);

const dns = require("node:dns");
const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
];
blockMethods(dns, dnsMethods);
const dnsPromises = require("node:dns/promises");
blockMethods(dnsPromises, dnsMethods);
if (dns.Resolver?.prototype) {
  blockMethods(dns.Resolver.prototype, Object.getOwnPropertyNames(dns.Resolver.prototype));
}
if (dnsPromises.Resolver?.prototype) {
  blockMethods(
    dnsPromises.Resolver.prototype,
    Object.getOwnPropertyNames(dnsPromises.Resolver.prototype)
  );
}

blockMethods(require("node:dgram"), ["createSocket"]);
blockMethods(require("node:http2"), ["connect"]);
blockMethods(require("node:child_process"), [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync"
]);
