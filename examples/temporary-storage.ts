/**
 * Temporary storage: a TTL cache and a JSON "database" with snapshots.
 * Run: npx tsx examples/temporary-storage.ts
 */
import { createFs } from "memspace";

const fs = createFs({ name: "cache", maxMemory: 8 * 1024 * 1024 });
fs.mkdirSync("/cache");
fs.mkdirSync("/db");

// TTL cache entry: invisible after 50 ms, memory reclaimed by an unref'd timer.
fs.writeFileSync("/cache/user-42.json", JSON.stringify({ name: "Ada" }), { ttl: 50 });
console.log("cached:", fs.existsSync("/cache/user-42.json"));
setTimeout(() => console.log("after ttl:", fs.existsSync("/cache/user-42.json")), 60);

// Tiny JSON store with atomic replace-by-rename.
function save(collection: string, data: unknown) {
  fs.writeFileSync(`/db/${collection}.json.tmp`, JSON.stringify(data));
  fs.renameSync(`/db/${collection}.json.tmp`, `/db/${collection}.json`);
}
save("todos", [{ id: 1, done: false }]);

// Snapshot the state (to send elsewhere, store in Redis, etc.) and restore it into another instance.
const snapshot = fs.snapshot({ format: "binary" });
const replica = createFs();
replica.restore(snapshot);
console.log("replica:", replica.readFileSync("/db/todos.json", "utf8"));
console.log("stats:", fs.getStats());
