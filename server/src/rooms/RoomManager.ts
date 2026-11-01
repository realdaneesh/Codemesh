import type { Member } from "../types/protocol";

export interface RoomClient<TClient> {
  client: TClient;
  member: Member;
}

export interface Room<TClient> {
  roomId: string;
  clients: Map<TClient, Member>;
}

export class RoomManager<TClient> {
  private readonly rooms = new Map<string, Room<TClient>>();
  private readonly clientRooms = new Map<TClient, string>();

  createRoom(client: TClient, member: Member): Room<TClient> {
    const roomId = this.generateRoomId();
    const room: Room<TClient> = {
      roomId,
      clients: new Map([[client, member]])
    };

    this.rooms.set(roomId, room);
    this.clientRooms.set(client, roomId);
    return room;
  }

  joinRoom(roomId: string, client: TClient, member: Member): Room<TClient> | undefined {
    const normalizedRoomId = roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);
    if (!room) {
      return undefined;
    }

    this.removeDuplicateMember(room, client, member.memberId);

    if (this.clientRooms.get(client) === normalizedRoomId) {
      room.clients.set(client, member);
      return room;
    }

    this.leaveRoom(client);
    room.clients.set(client, member);
    this.clientRooms.set(client, normalizedRoomId);
    return room;
  }

  leaveRoom(client: TClient): Room<TClient> | undefined {
    const roomId = this.clientRooms.get(client);
    if (!roomId) {
      return undefined;
    }

    const room = this.rooms.get(roomId);
    this.clientRooms.delete(client);

    if (!room) {
      return undefined;
    }

    room.clients.delete(client);
    if (room.clients.size === 0) {
      this.rooms.delete(roomId);
    }

    return room;
  }

  getMembers(room: Room<TClient>): Member[] {
    return [...room.clients.values()];
  }

  getClients(room: Room<TClient>): TClient[] {
    return [...room.clients.keys()];
  }

  getRoomForClient(client: TClient): Room<TClient> | undefined {
    const roomId = this.clientRooms.get(client);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  private removeDuplicateMember(room: Room<TClient>, client: TClient, memberId: string): void {
    for (const [existingClient, existingMember] of room.clients) {
      if (existingClient !== client && existingMember.memberId === memberId) {
        room.clients.delete(existingClient);
        this.clientRooms.delete(existingClient);
      }
    }
  }

  private generateRoomId(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let id = "";
      for (let index = 0; index < 6; index += 1) {
        id += alphabet[Math.floor(Math.random() * alphabet.length)];
      }

      if (!this.rooms.has(id)) {
        return id;
      }
    }

    throw new Error("Unable to generate a unique room ID");
  }
}
