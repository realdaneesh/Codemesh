const assert = require("node:assert/strict");
const { RoomManager } = require("../dist/rooms/RoomManager");

const rooms = new RoomManager();
const firstSocket = { id: "first" };
const replacementSocket = { id: "replacement" };
const peerSocket = { id: "peer" };
const self = { memberId: "same-member", displayName: "Self" };

const room = rooms.createRoom(firstSocket, self);
rooms.joinRoom(room.roomId, peerSocket, { memberId: "peer", displayName: "Peer" });
rooms.joinRoom(room.roomId, replacementSocket, self);

assert.deepEqual(
  rooms.getMembers(room).map((member) => member.memberId).sort(),
  ["peer", "same-member"]
);
assert.equal(rooms.getRoomForClient(firstSocket), undefined);
assert.equal(rooms.getRoomForClient(replacementSocket), room);
assert.equal(rooms.leaveRoom(firstSocket), undefined);
assert.equal(rooms.getMembers(room).length, 2);

const restartedRooms = new RoomManager();
assert.equal(
  restartedRooms.joinRoom(room.roomId, { id: "after-restart" }, { memberId: "late", displayName: "Late" }),
  undefined
);

console.log("PASS: reconnect identity replaces stale room membership and rooms are ephemeral after restart");
