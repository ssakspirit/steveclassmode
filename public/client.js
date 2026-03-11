/**
 * Steve Classroom Mode - 웹 클라이언트
 */

// ==================== 전역 상태 ====================

let ws = null;
let players = new Map();
let commandHistory = [];
let reconnectAttempts = 0;
let hostPlayerName = null;
let isWorldPaused = false;
const MAX_RECONNECT = 5;

// ==================== WebSocket 연결 ====================

async function connect() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    const wsUrl = `ws://${window.location.hostname}:${config.wsPort}/web`;
    console.log('WebSocket 연결 시도:', wsUrl);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✅ WebSocket 연결 성공!');
      reconnectAttempts = 0;
      updateConnectionStatus(true);
      addEventLog('system', '🌐 대시보드가 서버에 연결되었습니다. 마인크래프트 연결을 기다리는 중...');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleServerMessage(message);
      } catch (error) {
        console.error('메시지 파싱 오류:', error);
      }
    };

    ws.onclose = () => {
      console.log('❌ WebSocket 연결 종료');
      updateConnectionStatus(false);
      addEventLog('system', '서버 연결이 끊어졌습니다.');

      // 재연결 시도
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        setTimeout(() => {
          console.log(`재연결 시도 ${reconnectAttempts}/${MAX_RECONNECT}...`);
          connect();
        }, 3000);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket 오류:', error);
      addEventLog('error', 'WebSocket 오류 발생');
    };
  } catch (error) {
    console.error('설정 로드 실패:', error);
    addEventLog('error', '서버 설정 로드 실패. 서버 상태를 확인하세요.');
  }
}

// ==================== 서버 메시지 핸들러 ====================

function handleServerMessage(message) {
  console.log('📩 서버 메시지:', message);

  switch (message.type) {
    case 'init':
      // 연결되지 않은 상태로 대시보드 접근 시 강제 이동
      if (message.data.connected === false) {
        window.location.href = '/setup.html';
        return;
      }

      // 초기 상태 수신
      if (message.data.hostPlayerName) {
        hostPlayerName = message.data.hostPlayerName;
        updateHostUI();
      }
      
      if (message.data.players) {
        message.data.players.forEach(player => {
          players.set(player.name, player);
        });
        updatePlayerList();
      }
      if (message.data.events) {
        message.data.events.forEach(event => {
          addEventLogFromEvent(event);
        });
      }
      break;

    case 'event':
      // 마인크래프트 이벤트
      addEventLogFromEvent(message.data);
      break;

    case 'host_assigned':
      hostPlayerName = message.data.name;
      updateHostUI();
      addEventLog('system', `👑 ${hostPlayerName} 님이 선생님(호스트)으로 식별되었습니다.`);
      break;

    case 'player_join':
      players.set(message.data.name, message.data);
      updatePlayerList();
      addEventLog('join', `${message.data.name} 님이 입장했습니다.`);
      break;

    case 'player_leave':
      const player = players.get(message.data.name);
      if (player) {
        player.isConnected = false;
        updatePlayerList();
      }
      addEventLog('leave', `${message.data.name} 님이 퇴장했습니다.`);
      break;

    case 'player_move':
      const movedPlayer = players.get(message.data.name);
      if (movedPlayer) {
        if (message.data.position) {
          movedPlayer.position = message.data.position;
        }
        if (message.data.dimension) {
          movedPlayer.dimension = message.data.dimension;
        }
        updatePlayerList();
      }
      break;

    case 'player_chat':
      addEventLog('chat', `${message.data.player}: ${message.data.message}`);
      break;

    case 'command_response':
      const outputDiv = document.getElementById('command-output');
      if (outputDiv) {
        const item = document.createElement('div');
        item.style.color = message.data.statusCode === 0 ? '#10b981' : '#ef4444';
        item.style.marginBottom = '4px';
        item.textContent = `[응답] ${message.data.statusMessage}`;
        outputDiv.appendChild(item);
        outputDiv.scrollTop = outputDiv.scrollHeight;
      }
      break;

    case 'minecraft_connected':
      addEventLog('system', '🎮 마인크래프트가 서버에 연결되었습니다!');
      break;

    case 'minecraft_disconnected':
      addEventLog('system', '⚠️ 마인크래프트 연결이 끊어졌습니다.');
      players.forEach(p => p.isConnected = false);
      updatePlayerList();
      break;

    default:
      console.log('알 수 없는 메시지 타입:', message.type);
  }
}

function addEventLogFromEvent(event) {
  const eventName = event.body?.eventName || event.header?.messageType || 'Unknown';
  const eventData = JSON.stringify(event.body || {}, null, 2);
  addEventLog('event', `${eventName}: ${eventData}`);
}

// ==================== UI 업데이트 ====================

function updateConnectionStatus(connected) {
  const statusText = document.getElementById('connection-status');
  const statusDot = document.getElementById('status-dot');

  if (connected) {
    statusText.textContent = '🟢 서버 연결됨';
    statusDot.classList.add('connected');
  } else {
    statusText.textContent = '🔴 연결 끊김';
    statusDot.classList.remove('connected');
  }
}

function updatePlayerList() {
  const playerList = document.getElementById('player-list');
  const playerCount = document.getElementById('player-count');

  // 학생 수 집계 (온라인이면서 현재 방장이 아닌 사람만 카운트)
  const onlineStudents = Array.from(players.values()).filter(p => p.isConnected && p.name !== hostPlayerName);
  playerCount.textContent = `학생: ${onlineStudents.length}명`;

  if (players.size === 0) {
    playerList.innerHTML = '<div class="empty-state">학생이 없습니다.</div>';
    return;
  }

  playerList.innerHTML = '';
  players.forEach((player, name) => {
    const card = document.createElement('div');
    card.className = `player-card ${player.isConnected ? '' : 'offline'}`;

    const position = player.position
      ? `📍 X:${Math.round(player.position.x)} Y:${Math.round(player.position.y)} Z:${Math.round(player.position.z)}`
      : '위치 정보 없음';

    const dimension = player.dimension || '알 수 없음';
    const status = player.isConnected ? 'online' : 'offline';

    card.innerHTML = `
      <div class="player-info">
        <div class="player-name">
          ${name === hostPlayerName ? '👑 ' : ''}${name}
          <span class="badge badge-${status}">${player.isConnected ? '온라인' : '오프라인'}</span>
          ${name === hostPlayerName ? '<span class="badge" style="background: #fbbf24; color: #78350f;">선생님</span>' : ''}
        </div>
        <div class="player-details">
          ${position}<br>
          🌍 차원: ${dimension}
        </div>
      </div>
      <div class="player-actions">
        <button class="btn-action btn-teleport" onclick="teleportPlayer('${name}')" ${!player.isConnected ? 'disabled' : ''}>
          📍 TP
        </button>
        <button class="btn-action btn-freeze" onclick="freezePlayer('${name}')" ${!player.isConnected ? 'disabled' : ''}>
          ❄️ Freeze
        </button>
        <button class="btn-action btn-mute" onclick="mutePlayer('${name}')" ${!player.isConnected ? 'disabled' : ''}>
          🔇 Mute
        </button>
      </div>
    `;

    playerList.appendChild(card);
  });
}

function addEventLog(type, message) {
  const eventLog = document.getElementById('event-log');
  const eventItem = document.createElement('div');
  eventItem.className = `event-item ${type}`;

  const timestamp = new Date().toLocaleTimeString('ko-KR');
  eventItem.innerHTML = `
    <span class="event-time">[${timestamp}]</span>
    ${escapeHtml(message)}
  `;

  eventLog.appendChild(eventItem);
  eventLog.scrollTop = eventLog.scrollHeight;

  // 최대 100개 유지
  while (eventLog.children.length > 100) {
    eventLog.removeChild(eventLog.firstChild);
  }
}

function addCommandHistory(command) {
  const output = document.getElementById('command-output');
  const item = document.createElement('div');
  item.className = 'command-history-item';

  const timestamp = new Date().toLocaleTimeString('ko-KR');
  item.textContent = `[${timestamp}] > ${command}`;

  output.appendChild(item);
  output.scrollTop = output.scrollHeight;

  commandHistory.push(command);
}

// ==================== 명령 전송 ====================

function sendCommand(cmdStr) {
  let command = cmdStr;
  let inputElement = null;
  
  // 만약 인자로 넘어온 명령어가 없으면 입력창에서 가져옴
  if (!command) {
    inputElement = document.getElementById('command-input');
    if (!inputElement) return;
    command = inputElement.value.trim();
  }

  if (!command) return;

  // WebSocket으로 전송
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'command',
      command: command
    };
    
    // 디버깅을 위해 콘솔과 화면 로그에 정확한 페이로드 출력
    console.log('📤 [명령어 전송 시도]:', JSON.stringify(payload));
    addEventLog('system', `📡 [서버로 전송]: ${command}`);

    ws.send(JSON.stringify(payload));

    addCommandHistory(command);
    if (inputElement) {
      inputElement.value = '';
    }
  } else {
    alert('서버에 연결되지 않았습니다!');
  }
}

function sendPreset(command) {
  const input = document.getElementById('command-input');
  input.value = command;
  sendCommand();
}

// ==================== 플레이어 액션 ====================

function teleportPlayer(playerName) {
  const command = `/tp "${playerName}" 0 100 0`;
  sendPreset(command);
  addEventLog('system', `${playerName}을(를) (0, 100, 0)으로 텔레포트합니다.`);
}

function freezePlayer(playerName) {
  const command = `/ability "${playerName}" mayfly false`;
  sendPreset(command);
  addEventLog('system', `${playerName}을(를) 동결합니다.`);
}

function mutePlayer(playerName) {
  const command = `/ability "${playerName}" mute true`;
  sendPreset(command);
  addEventLog('system', `${playerName}을(를) 음소거합니다.`);
}

// ==================== 월드 퍼즈 (학생 전체 얼리기) ====================

function updateHostUI() {
  const btn = document.getElementById('btn-world-pause');
  if (btn) {
    if (hostPlayerName) {
      btn.disabled = false;
      btn.title = `호스트(${hostPlayerName})를 제외한 모든 학생을 제어합니다.`;
    } else {
      btn.disabled = true;
      btn.title = '아직 방장(선생님)이 인식되지 않았습니다.';
    }
  }
}

function toggleWorldPause() {
  if (!hostPlayerName) {
    alert('아직 선생님(호스트) 플레이어가 접속되지 않아 기능을 사용할 수 없습니다.');
    return;
  }

  const btn = document.getElementById('btn-world-pause');
  isWorldPaused = !isWorldPaused;

  if (isWorldPaused) {
    // 얼리기 (disabled): 선생님이 직접 확인한 문법으로 롤백!
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] movement disabled`);
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] camera disabled`);
    
    // 추가: 월드 전체 건축 금지 (Immutable World 켜기)
    sendCommand(`/immutableworld true`);
    
    btn.innerHTML = '▶️ 학생 전체 행동 해제';
    btn.style.background = '#e53e3e';
    btn.style.color = '#fff';
    addEventLog('system', `⏸️ ${hostPlayerName} 선생님을 제외한 모든 학생을 얼렸습니다.`);
  } else {
    // 해제하기 (enabled)
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] movement enabled`);
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] camera enabled`);
    
    // 추가: 월드 전체 건축 허용 (Immutable World 끄기)
    sendCommand(`/immutableworld false`);
    
    // 추가: 마인크래프트 버그 보완 (inputpermission 해제 후 선생님의 비행 능력이 증발하는 현상 복구)
    sendCommand(`/ability "${hostPlayerName}" mayfly true`);
    
    btn.innerHTML = '⏸️ 학생 전체 행동 얼리기';
    btn.style.background = '';
    btn.style.color = '';
    addEventLog('system', `▶️ 학생들의 행동 제한을 해제했습니다.`);
  }
}

// ==================== 유틸리티 ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== 초기화 ====================

document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Steve Classroom Mode 클라이언트 시작');
  connect();

  // Enter 키로 명령 전송
  const input = document.getElementById('command-input');
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendCommand();
    }
  });
});
