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
let hostDetectRequestId: string | null = null; // 호스트 감지용 /testfor @s 요청 ID
let listInterval: NodeJS.Timeout | null = null; // /list 주기 갱신 타이머 (연결당 1개)

// ==================== 접속 보안 ====================

/** 이 컴퓨터(루프백)에서 온 접속인지 확인 — 같은 와이파이의 다른 PC 차단 */
function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 브라우저 Origin이 우리 대시보드 페이지인지 확인 — 외부 웹사이트에서의 요청 차단 */
function isOwnOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      && url.port === String(httpPort);
  } catch {
    return false;
  }
}

/** Host 헤더가 localhost인지 확인 — DNS 리바인딩 공격 차단 */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// ==================== 로그 파일 ====================

// pkg(실행 파일화) 환경을 위해 __dirname 대신 process.cwd() 사용
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(LOG_DIR, `minecraft-${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

function logEvent(event: WsEvent) {
  const eventName = event.body?.eventName || event.header?.eventName || event.header?.messagePurpose || event.header?.messageType || 'Unknown';

  eventLog.push(event);
  if (eventLog.length > MAX_LOG_SIZE) {
    eventLog.shift();
  }

  // 필터링할 이벤트 (너무 자주 발생하거나 무의미한 스팸)
  const isSpam = 
    eventName === 'PlayerTravelled' || 
    eventName === 'ChunkChanged' || 
    (eventName === 'commandResponse' && event.body?.statusMessage && event.body.statusMessage.includes('온라인:'));

  if (!isSpam) {
    logToFile(`EVENT: ${eventName} | ${JSON.stringify(event.body || {})}`);
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

  const wss = new WebSocketServer({
    port: wsPort,
    verifyClient: ({ req, origin }: { req: http.IncomingMessage; origin: string }) => {
      // 1) 이 컴퓨터에서 온 접속만 허용 (학생 PC 등 외부 접속 차단)
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        console.log(`⛔ [차단] 외부 접속 거부: ${req.socket.remoteAddress}`);
        return false;
      }
      // 2) 대시보드(/web)는 우리 웹페이지에서 연 것만 허용
      if (req.url === '/web') {
        return isOwnOrigin(origin);
      }
      // 3) 마인크래프트 연결은 브라우저(웹사이트)에서 열 수 없게 차단
      //    (브라우저는 항상 http(s) Origin을 보내지만 마인크래프트는 보내지 않음)
      if (origin && /^https?:/i.test(origin)) {
        console.log(`⛔ [차단] 웹사이트에서의 마인크래프트 위장 접속 거부: ${origin}`);
        return false;
      }
      return true;
    }
  });

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
      // 마인크래프트 연결로 간주 (이전 연결이 남아 있으면 정리)
      if (minecraftConnection && minecraftConnection !== ws) {
        minecraftConnection.close();
      }
      minecraftConnection = ws;
      hostPlayerName = null; // 새 연결마다 호스트를 다시 감지
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
          if (message.type === 'command' && minecraftConnection && typeof message.command === 'string') {
            sendCommand(message.command);
          } else if (message.type === 'say' && minecraftConnection && typeof message.text === 'string') {
            // 일반 채팅: /로 시작하면 명령어, 아니면 /say로 전달
            if (message.text.startsWith('/')) {
              sendCommand(message.text);
            } else {
              sendCommand(`/say ${message.text}`);
            }
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
        hostDetectRequestId = null;
        if (listInterval) {
          clearInterval(listInterval);
          listInterval = null;
        }

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

    const messagePurpose = event.header?.messagePurpose;
    const eventName = event.body?.eventName || event.header?.eventName;

    // commandResponse: 명령 응답에서 발신자/플레이어 이름 추출
    if (messagePurpose === 'commandResponse') {
      // /list 명령 응답: players 필드에 "sm01, lees, sangminj" 형태의 문자열로 접속자 목록이 들어옴
      if (typeof event.body?.players === 'string' && event.body.players.trim()) {
        const nameList: string[] = event.body.players.split(',').map((n: string) => n.trim()).filter(Boolean);
        syncPlayerList(nameList);
      }
      // 혹시 배열 형태로 오는 경우도 대비
      else if (Array.isArray(event.body?.player) && event.body.player.length > 0) {
        syncPlayerList(event.body.player.filter((n: any) => typeof n === 'string' && n));
      }

      // 호스트 감지: 우리가 보낸 /testfor @s 의 응답일 때만 victim[0]을 호스트로 지정
      // (/tp 등 다른 명령 응답에도 victim이 오므로 requestId로 반드시 구분해야 함)
      const isHostDetectResponse =
        hostDetectRequestId !== null && event.header?.requestId === hostDetectRequestId;
      if (isHostDetectResponse && Array.isArray(event.body?.victim) && event.body.victim.length === 1) {
        hostDetectRequestId = null;
        setHost(event.body.victim[0]);
      }
      return;
    }

    switch (eventName) {
      case 'PlayerJoin':
      case 'PlayerConnect':
        handlePlayerJoin(event);
        break;

      case 'PlayerLeave':
      case 'PlayerDisconnect':
        handlePlayerLeave(event);
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

  /** /testfor @s 응답으로 확인된 플레이어를 호스트(선생님)로 지정 */
  function setHost(playerName: string) {
    if (!playerName || hostPlayerName === playerName) return;
    hostPlayerName = playerName;
    console.log(`👑 [호스트 지정] ${playerName} 님이 선생님(호스트)으로 설정되었습니다.`);
    ensurePlayerExists(playerName);
    broadcastToWebClients({
      type: 'host_assigned',
      data: { name: playerName }
    });
  }

  /** /list 결과와 비교해 접속자 목록 동기화 (새 접속자 추가 + 빠진 사람 퇴장 처리) */
  function syncPlayerList(onlineNames: string[]) {
    const online = new Set(onlineNames);
    onlineNames.forEach(name => ensurePlayerExists(name));
    players.forEach(player => {
      if (player.isConnected && !online.has(player.name)) {
        markPlayerLeft(player.name);
      }
    });
  }

  function markPlayerLeft(playerName: string) {
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

  function ensurePlayerExists(playerName: string) {
    if (!playerName) {
      console.log('⚠️ [디버그] ensurePlayerExists에 빈 이름이 전달되었습니다.');
      return null;
    }

    let player = players.get(playerName);
    if (!player) {
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
    } else if (!player.isConnected) {
      // 퇴장했던 플레이어가 다시 들어온 경우 (재접속 / 마인크래프트 재연결)
      player.isConnected = true;
      player.lastSeen = new Date();
      console.log(`👤 [재접속] ${playerName} 님이 다시 접속했습니다.`);

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

    markPlayerLeft(playerName);
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

  let lastChatMessage = '';
  let lastChatTime = 0;

  function handlePlayerChat(event: WsEvent) {
    const rawPlayer: any = event.body?.player;
    const msgType: string = event.body?.type || event.body?.properties?.MessageType || 'chat';
    const rawMessage: string = event.body?.message || event.body?.properties?.Message || '';

    let playerName: string | undefined;
    let displayMessage: string = rawMessage;

    if (msgType === 'say') {
      // /say 커맨드: message = "[교사] 내용" 형태 → 브래킷 접두사 제거 후 호스트 이름 사용
      const bracketEnd = rawMessage.indexOf('] ');
      displayMessage = bracketEnd !== -1 ? rawMessage.substring(bracketEnd + 2) : rawMessage;
      playerName = '교사'; // 클래스룸 채팅창에서 보낸 메시지는 항상 <교사>로 표시
    } else if (rawMessage.startsWith('{"rawtext"')) {
      // tellraw JSON 포맷 파싱 및 정리
      try {
        const parsed = JSON.parse(rawMessage);
        if (Array.isArray(parsed.rawtext)) {
          const textParts = parsed.rawtext.map((part: any) => part.text || '').join('');
          displayMessage = textParts.replace(/§[0-9a-fk-or]/ig, ''); // 인게임 색상코드 제거
        }
        playerName = '시스템 알림';
      } catch (e) {
        displayMessage = rawMessage;
      }
    } else {
      // 일반 채팅: sender 필드에 발신자 이름이 있음
      playerName =
        (rawPlayer && typeof rawPlayer === 'object' ? rawPlayer.name : rawPlayer) ||
        event.body?.sender ||
        event.body?.properties?.Sender ||
        event.body?.origin?.name;
    }

    // ==================== 중복 메시지 방어 (500ms 쿨타임) ====================
    const now = Date.now();
    if (displayMessage === lastChatMessage && (now - lastChatTime) < 500) {
      return; // 완전히 동일한 내용이 순식간에 중복 발생하면 첫 번째만 띄우고 무시
    }
    lastChatMessage = displayMessage;
    lastChatTime = now;

    // 실제 플레이어만 목록에 등록 (가상 발신자 "교사", "시스템 알림" 등 제외)
    // (채팅을 쳤다는 것은 접속 중이라는 뜻이므로 퇴장 처리된 플레이어도 다시 접속 상태로 복구)
    if (playerName && msgType !== 'say' && !rawMessage.startsWith('{"rawtext"')) {
      ensurePlayerExists(playerName);
    }

    console.log(`💬 [채팅] ${playerName || '알 수 없음'}: ${displayMessage}`);

    broadcastToWebClients({
      type: 'player_chat',
      data: { player: playerName || '알 수 없음', message: displayMessage }
    });
  }

  // ==================== 명령 전송 ====================

  function subscribeToEvents() {
    // 이 함수를 호출한 시점의 연결을 기억 → 그 사이 재연결되면 예약된 작업은 무시
    const conn = minecraftConnection;
    if (!conn) return;
    const isSameOpenConnection = () => minecraftConnection === conn && conn.readyState === WebSocket.OPEN;

    const makeSubscribe = (eventName: string): any => ({
      header: { requestId: uuidv4(), messagePurpose: 'subscribe', version: 1, messageType: 'commandRequest' },
      body: { eventName }
    });

    const sendInternalCommand = (commandLine: string): string => {
      const requestId = uuidv4();
      conn.send(JSON.stringify({
        header: { requestId, messagePurpose: 'commandRequest', version: 1, messageType: 'commandRequest' },
        body: { version: 1, commandLine, origin: { type: 'player' } }
      }));
      return requestId;
    };

    // /testfor @s → 응답의 victim[0]이 호스트 (requestId로 응답을 구분)
    const requestHostDetect = () => {
      hostDetectRequestId = sendInternalCommand('/testfor @s');
    };

    // 구독 메시지를 300ms 간격으로 순차 전송 (동시 전송 시 Minecraft가 일부 무시할 수 있음)
    const events = ['PlayerJoin', 'PlayerLeave', 'PlayerMessage']; // PlayerTravelled 제거: 위치 UI 없음 + /list 폴링으로 대체
    events.forEach((eventName, i) => {
      setTimeout(() => {
        if (isSameOpenConnection()) {
          console.log(`📬 이벤트 구독: ${eventName}`);
          conn.send(JSON.stringify(makeSubscribe(eventName)));
        }
      }, i * 300);
    });

    // 1.5초 후: /testfor @s → 호스트 이름 감지 (플레이어에게 보이지 않음)
    setTimeout(() => {
      if (isSameOpenConnection()) {
        console.log('🔍 [1/2] 호스트 감지 위한 /testfor @s 전송');
        requestHostDetect();
      }
    }, 1500);

    // 2.5초 후: /list → 현재 접속자 전체 목록 초기 파악
    setTimeout(() => {
      if (isSameOpenConnection()) {
        console.log('🔍 [2/2] 전체 접속자 파악 위한 /list 전송');
        sendInternalCommand('/list');
      }
    }, 2500);

    // 5초마다 /list 자동 갱신: PlayerJoin/Leave 이벤트 누락 시 최대 5초 내 동기화
    // 이전 연결의 타이머가 남아 있으면 먼저 정리 (재연결 시 중복 방지)
    if (listInterval) clearInterval(listInterval);
    const thisInterval = setInterval(() => {
      if (!isSameOpenConnection()) {
        clearInterval(thisInterval);
        if (listInterval === thisInterval) listInterval = null;
        return;
      }
      sendInternalCommand('/list');
      // 호스트를 아직 못 찾았으면 다시 시도
      if (!hostPlayerName) requestHostDetect();
    }, 5000);
    listInterval = thisInterval;
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

    // 이 컴퓨터에서, localhost 주소로 접속한 요청만 허용
    // (학생 PC 접속 · DNS 리바인딩 차단. CORS 헤더는 일부러 넣지 않음 → 외부 웹사이트가 API를 읽을 수 없음)
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host)) {
      res.writeHead(403);
      res.end('403 Forbidden');
      return;
    }

    // POST 요청은 우리 대시보드 페이지에서 보낸 것만 허용 (외부 웹사이트의 위조 요청 차단)
    if (req.method === 'POST' && !isOwnOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '허용되지 않은 요청' }));
      return;
    }

    // 쿼리스트링(?v=1 등) 제거한 경로
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end('400 Bad Request');
      return;
    }

    // API 엔드포인트
    if (pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ wsPort }));
      return;
    }

    if (pathname === '/api/players' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.from(players.values())));
      return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy(); // 비정상적으로 큰 요청 차단
      });
      req.on('end', () => {
        try {
          const { command } = JSON.parse(body);
          if (typeof command !== 'string' || !command.trim()) throw new Error('invalid command');
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

    if (pathname === '/api/loopback-exempt' && req.method === 'POST') {
      // 윈도우 관리자 권한 팝업을 띄우고 명령어 실행
      const psCommand = `powershell -Command "Start-Process cmd -ArgumentList '/c CheckNetIsolation LoopbackExempt -a -n=Microsoft.MinecraftUWP_8wekyb3d8bbwe' -Verb RunAs"`;
      exec(psCommand, (error) => {
        if (error) {
          console.error('Loopback exempt error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '권한 부여 실패 (취소됨)' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
      });
      return;
    }

    // 정적 파일 제공 (public 폴더 밖으로 벗어나는 경로는 차단)
    const publicDir = path.resolve(__dirname, '../public');
    const filePath = pathname === '/' ? '/setup.html' : pathname;
    const fullPath = path.resolve(publicDir, '.' + filePath);
    if (!fullPath.startsWith(publicDir + path.sep)) {
      res.writeHead(403);
      res.end('403 Forbidden');
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(fullPath);
      const contentType: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
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
