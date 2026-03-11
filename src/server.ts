/**
 * Steve Classroom Mode - 마인크래프트 에듀케이션 WebSocket 서버
 * 클래스룸 모드와 동일한 프로토콜 사용
 */

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { exec } from 'child_process';

// ==================== 타입 정의 ====================

/** 플레이어 정보 */
interface PlayerInfo {
  name: string;
  uuid: string;
  position?: { x: number; y: number; z: number };
  dimension?: string;
  isConnected: boolean;
  lastSeen: Date;
}

/** WebSocket 이벤트 메시지 (마인크래프트 → 서버) */
interface WsEvent {
  header: {
    requestId: string;
    messagePurpose: string;
    version: number;
    messageType: string;
    eventName?: string;
  };
  body: {
    eventName?: string;
    properties?: any;
    player?: string;
    message?: string;
    position?: { x: number; y: number; z: number };
    dimension?: string;
    statusCode?: number;
    statusMessage?: string;
    [key: string]: any;
  };
}

/** 명령 요청 (서버 → 마인크래프트) */
interface CommandRequest {
  header: {
    requestId: string;
    messagePurpose: string;
    version: number;
    messageType: string;
  };
  body: {
    version: number;
    commandLine: string;
    origin?: {
      type: string;
    };
  };
}

// 포트 자동 탐색 함수
async function findAvailablePort(startPort: number, endPort: number): Promise<number | null> {
  const isPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false);
        }
      });
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  };

  for (let port = startPort; port <= endPort; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return null;
}

// ==================== 글로벌 상태 ====================

const players: Map<string, PlayerInfo> = new Map();
const eventLog: WsEvent[] = [];
const MAX_LOG_SIZE = 1000;

let minecraftConnection: WebSocket | null = null;
let webClients: Set<WebSocket> = new Set();
let wsPort: number = 3000;
let httpPort: number = 3001;
let hostPlayerName: string | null = null; // 방장 (선생님) 이름 저장용

// ==================== 로그 파일 ====================

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(LOG_DIR, `minecraft-${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

function logEvent(event: WsEvent) {
  const eventName = event.body?.eventName || event.header?.eventName || event.header?.messageType || 'Unknown';

  eventLog.push(event);
  if (eventLog.length > MAX_LOG_SIZE) {
    eventLog.shift();
  }

  logToFile(`EVENT: ${eventName} | ${JSON.stringify(event.body || {})}`);

  // 너무 자주 발생하는 이벤트는 콘솔 출력 생략 (다만 로그 파일에는 남김)
  if (eventName !== 'PlayerTravelled') {
    console.log(`📥 [이벤트] ${eventName}:`, event.body || {});
  }
}

// ==================== 메인 서버 실행 ====================
async function startServer() {
  const foundWsPort = await findAvailablePort(3000, 3050);
  if (!foundWsPort) {
    console.log('❌ 사용 가능한 WebSocket 포트를 찾을 수 없습니다.');
    process.exit(1);
  }
  wsPort = foundWsPort;

  const foundHttpPort = await findAvailablePort(foundWsPort + 1, 3100);
  if (!foundHttpPort) {
    console.log('❌ 사용 가능한 HTTP 포트를 찾을 수 없습니다.');
    process.exit(1);
  }
  httpPort = foundHttpPort;

  // ==================== WebSocket 서버 ====================

  const wss = new WebSocketServer({ port: wsPort });

  console.log(`\n🎮 Steve Classroom Mode 서버 시작!`);
  console.log(`📡 WebSocket 서버: ws://localhost:${wsPort}`);
  console.log(`🌐 웹 클라이언트: http://localhost:${httpPort}`);
  console.log(`\n마인크래프트 에듀에서 연결하세요 (3가지 방법):`);
  console.log(`  1) /connect localhost:${wsPort}           ← 권장!`);
  console.log(`  2) /connect ws://localhost:${wsPort}`);
  console.log(`  3) /wsserver ws://localhost:${wsPort}\n`);

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const clientId = uuidv4();
    const clientIp = req.socket.remoteAddress;

    // URL로 웹 클라이언트와 마인크래프트 클라이언트 구분
    const isWebClient = req.url === '/web';

    console.log(`🔌 [연결] 클라이언트 연결됨: ${clientId} (${clientIp}) - ${isWebClient ? 'Web Client' : 'Minecraft'}`);
    logToFile(`CONNECTION: ${clientId} from ${clientIp} (${isWebClient ? 'Web' : 'MC'})`);

    if (isWebClient) {
      webClients.add(ws);
      // 초기 상태 전송 (웹 클라이언트용)
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          players: Array.from(players.values()),
          events: eventLog.slice(-50),
          connected: minecraftConnection !== null,
          hostPlayerName: hostPlayerName
        }
      }));
    } else {
      // 마인크래프트 연결로 간주
      minecraftConnection = ws;
      console.log(`✅ 마인크래프트 클라이언트 확인됨! (${clientId})`);

      // 웹 클라이언트들에게 마인크래프트 연결 알림
      broadcastToWebClients({
        type: 'minecraft_connected'
      });

      // 구독 요청 전송
      subscribeToEvents();
    }

    ws.on('message', (data: Buffer) => {
      try {
        const rawMessage = data.toString();
        const message: any = JSON.parse(rawMessage);

        if (isWebClient) {
          // 웹 클라이언트 메시지
          if (message.type === 'command' && minecraftConnection) {
            sendCommand(message.command);
          }
          return;
        }

        // 마인크래프트 메시지
        if (!message.header || !message.body) {
          console.log('⚠️ 잘못된 형식, 무시');
          return;
        }

        const mcMessage = message as WsEvent;

        handleMinecraftEvent(mcMessage);

        // 웹 클라이언트들에게 브로드캐스트
        broadcastToWebClients({
          type: 'event',
          data: mcMessage
        });

      } catch (error) {
        console.error('❌ 메시지 파싱 오류:', error);
      }
    });

    ws.on('close', () => {
      if (!isWebClient && ws === minecraftConnection) {
        console.log(`🔴 [연결 끊김] 마인크래프트 연결 종료`);
        minecraftConnection = null;
        hostPlayerName = null; // 호스트 연결 해제

        // 모든 플레이어 상태를 연결 끊김으로
        players.forEach(player => {
          player.isConnected = false;
        });

        broadcastToWebClients({
          type: 'minecraft_disconnected'
        });
      } else if (isWebClient) {
        webClients.delete(ws);
        console.log(`🔴 [연결 끊김] 웹 클라이언트 종료`);
      }
      logToFile(`DISCONNECT: ${clientId}`);
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket 오류:', error);
    });
  });

  // ==================== 이벤트 핸들러 ====================

  function handleMinecraftEvent(event: WsEvent) {
    logEvent(event);

    const eventName = event.body?.eventName || event.header?.eventName;

    switch (eventName) {
      case 'PlayerJoin':
      case 'PlayerConnect':
        handlePlayerJoin(event);
        break;

      case 'PlayerLeave':
      case 'PlayerDisconnect':
        handlePlayerLeave(event);
        break;

      case 'PlayerTeleport':
      case 'PlayerTransform':
      case 'PlayerTravelled':
        handlePlayerMove(event);
        break;

      case 'PlayerMessage':
      case 'ChatMessage':
        handlePlayerChat(event);
        break;

      default:
        // 기타 이벤트는 로그만
        break;
    }
  }

  function ensurePlayerExists(playerName: string) {
    if (!playerName) {
      console.log('⚠️ [디버그] ensurePlayerExists에 빈 이름이 전달되었습니다.');
      return null;
    }

    let player = players.get(playerName);
    if (!player) {
      // 첫 연결인 경우 호스트(선생님)로 지정
      if (!hostPlayerName) {
        hostPlayerName = playerName;
        console.log(`👑 [호스트 지정] ${playerName} 님이 선생님(호스트)으로 설정되었습니다.`);
        broadcastToWebClients({
          type: 'host_assigned',
          data: { name: playerName }
        });
      }

      player = {
        name: playerName,
        uuid: uuidv4(),
        isConnected: true,
        lastSeen: new Date()
      };
      players.set(playerName, player);
      console.log(`👤 [접속 감지] ${playerName} 님이 발견되었습니다.`);

      broadcastToWebClients({
        type: 'player_join',
        data: player
      });
    }
    return player;
  }

  function handlePlayerJoin(event: WsEvent) {
    const rawPlayer: any = event.body?.player;
    const playerName = (rawPlayer && typeof rawPlayer === 'object' ? rawPlayer.name : rawPlayer) || event.body?.properties?.PlayerName;
    
    if (!playerName) {
      console.log('⚠️ [디버그] handlePlayerJoin: 닉네임 파싱 실패', JSON.stringify(event.body));
      return;
    }

    ensurePlayerExists(playerName);
  }

  function handlePlayerLeave(event: WsEvent) {
    const rawPlayer: any = event.body.player;
    const playerName = (typeof rawPlayer === 'object' ? rawPlayer.name : rawPlayer) || event.body.properties?.PlayerName;
    if (!playerName) return;

    const player = players.get(playerName);
    if (player) {
      player.isConnected = false;
      player.lastSeen = new Date();
      console.log(`👋 [퇴장] ${playerName} 님이 퇴장했습니다.`);
    }

    broadcastToWebClients({
      type: 'player_leave',
      data: { name: playerName }
    });
  }

  function handlePlayerMove(event: WsEvent) {
    const rawPlayer: any = event.body?.player;
    const playerName = (rawPlayer && typeof rawPlayer === 'object' ? rawPlayer.name : rawPlayer) || event.body?.properties?.PlayerName;
    const position = event.body?.position || event.body?.properties?.Position || (rawPlayer && typeof rawPlayer === 'object' ? rawPlayer.position : undefined);
    const dimension = event.body?.dimension || event.body?.properties?.Dimension || (rawPlayer && typeof rawPlayer === 'object' ? rawPlayer.dimension : undefined);

    if (!playerName) {
      console.log('⚠️ [디버그] handlePlayerMove: 닉네임 파싱 실패', JSON.stringify(event.body));
      return;
    }

    const player = ensurePlayerExists(playerName);
    if (player) {
      const now = new Date();
      if (position) {
        player.position = position;
      }
      if (dimension) {
        player.dimension = dimension;
      }
      
      // 지나치게 잦은 player_move 브로드캐스트 방지 (1초 단위 쓰로틀링)
      const timeSinceLastSeen = now.getTime() - player.lastSeen.getTime();
      if (timeSinceLastSeen > 1000) {
        player.lastSeen = now;
        broadcastToWebClients({
          type: 'player_move',
          data: { name: playerName, position, dimension }
        });
      }
    }
  }

  function handlePlayerChat(event: WsEvent) {
    const rawPlayer: any = event.body.player;
    const playerName = (typeof rawPlayer === 'object' ? rawPlayer.name : rawPlayer) || event.body.properties?.Sender;
    const message = event.body.message || event.body.properties?.Message;

    if (playerName) ensurePlayerExists(playerName);

    console.log(`💬 [채팅] ${playerName}: ${message}`);

    broadcastToWebClients({
      type: 'player_chat',
      data: { player: playerName, message }
    });
  }

  // ==================== 명령 전송 ====================

  function subscribeToEvents() {
    if (!minecraftConnection) return;

    // 클래스룸 모드처럼 이벤트 구독 요청
    const subscribeMessage: any = {
      header: {
        requestId: uuidv4(),
        messagePurpose: 'subscribe',
        version: 1,
        messageType: 'commandRequest'
      },
      body: {
        eventName: 'PlayerTravelled'
      }
    };

    console.log('📬 이벤트 구독 요청 전송...');
    minecraftConnection.send(JSON.stringify(subscribeMessage));
  }

  function sendCommand(commandLine: string): boolean {
    if (!minecraftConnection || minecraftConnection.readyState !== WebSocket.OPEN) {
      console.error('❌ 마인크래프트가 연결되지 않았습니다.');
      return false;
    }

    const commandRequest: CommandRequest = {
      header: {
        requestId: uuidv4(),
        messagePurpose: 'commandRequest',
        version: 1,
        messageType: 'commandRequest'
      },
      body: {
        version: 1,
        commandLine: commandLine,
        origin: {
          type: 'player'
        }
      }
    };

    console.log(`📤 [명령 전송] ${commandLine}`);
    logToFile(`COMMAND: ${commandLine}`);

    minecraftConnection.send(JSON.stringify(commandRequest));
    return true;
  }

  // ==================== 웹 클라이언트 통신 ====================

  function broadcastToWebClients(message: any) {
    const payload = JSON.stringify(message);
    webClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  // ==================== HTTP 서버 (웹 UI용) ====================

  const httpServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {

    // CORS 허용
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // API 엔드포인트
    if (req.url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ wsPort }));
      return;
    }

    if (req.url === '/api/players' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.from(players.values())));
      return;
    }

    if (req.url === '/api/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { command } = JSON.parse(body);
          const success = sendCommand(command);
          res.writeHead(success ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success, message: success ? '명령 전송 완료' : '마인크래프트 연결 없음' }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '잘못된 요청' }));
        }
      });
      return;
    }

    // 정적 파일 제공
    const filePath = req.url === '/' ? '/setup.html' : (req.url || '/setup.html');
    const fullPath = path.join(__dirname, '../public', filePath);

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(fullPath);
      const contentType: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
      };
      const type = contentType[ext] || 'text/plain';

      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });

  httpServer.listen(httpPort, () => {
    console.log(`🌐 웹 서버 시작: http://localhost:${httpPort}\n`);

    // 브라우저 탭 자동 열기
    console.log(`🚀 브라우저를 자동으로 엽니다...`);
    exec(`start http://localhost:${httpPort}/setup.html`);
  });

  // ==================== 프로세스 종료 처리 ====================

  process.on('SIGINT', () => {
    console.log('\n\n👋 서버 종료 중...');
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}

// 애플리케이션 시작
startServer().catch(err => {
  console.error("❌ 서버 시작 중 오류 발생:", err);
  process.exit(1);
});
