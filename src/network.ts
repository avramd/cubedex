import Peer, { DataConnection } from 'peerjs';

const PREFIX = 'cubedex-';
const WORDS = [
  'TIGER', 'PANDA', 'EAGLE', 'SHARK', 'COBRA', 'BISON', 'LYNX', 'CRANE',
  'VIPER', 'DINGO', 'MOOSE', 'RAVEN', 'OTTER', 'GECKO', 'FINCH', 'TAPIR',
  'HYENA', 'OKAPI', 'STOAT', 'QUAIL', 'BISON', 'SWIFT', 'SKUNK', 'RHINO',
  'SHREW', 'STORK', 'HERON', 'LLAMA', 'CAMEL', 'LEMUR',
];

export type NetMessage =
  | { type: 'gyro'; x: number; y: number; z: number; w: number }
  | { type: 'move'; move: string }
  | { type: 'alg'; alg: string[]; name: string }
  | { type: 'scramble'; text: string; mode: boolean }
  | { type: 'state'; alg: string[]; name: string; scramble: string; scrambleMode: boolean; hasCube: boolean; moves?: string[] }
  | { type: 'cube-connected'; connected: boolean }
  | { type: 'camera'; lat: number; lon: number }
  | { type: 'challenge-scramble'; alg: string[]; name: string };

export function generateRoomCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${word}-${num}`;
}

export function toPeerId(code: string): string {
  return PREFIX + code.toUpperCase();
}

export function fromPeerId(id: string): string {
  return id.replace(PREFIX, '');
}

export class NetPeer {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;

  onMessage: (msg: NetMessage) => void = () => {};
  onConnected: () => void = () => {};
  onDisconnected: () => void = () => {};
  onError: (err: string) => void = () => {};

  get connected(): boolean {
    return this.conn !== null && this.conn.open;
  }

  host(): Promise<string> {
    const roomCode = generateRoomCode();
    return new Promise((resolve, reject) => {
      this.peer = new Peer(toPeerId(roomCode));
      this.peer.on('open', () => resolve(roomCode));
      this.peer.on('error', (err) => {
        this.onError(err.message);
        reject(err);
      });
      this.peer.on('connection', (conn) => this.setupConn(conn));
    });
  }

  join(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer();
      this.peer.on('open', () => {
        const conn = this.peer!.connect(toPeerId(code), { reliable: true, serialization: 'json' });
        this.setupConn(conn);
        conn.on('open', () => resolve());
        conn.on('error', (err) => {
          this.onError(String(err));
          reject(err);
        });
      });
      this.peer.on('error', (err) => {
        this.onError(err.message);
        reject(err);
      });
    });
  }

  private setupConn(conn: DataConnection) {
    this.conn = conn;
    conn.on('open', () => this.onConnected());
    conn.on('data', (data) => this.onMessage(data as NetMessage));
    conn.on('close', () => {
      this.conn = null;
      this.onDisconnected();
    });
    conn.on('error', (err) => this.onError(String(err)));
  }

  send(msg: NetMessage): void {
    if (this.conn?.open) {
      this.conn.send(msg);
    }
  }

  disconnect(): void {
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
  }
}
