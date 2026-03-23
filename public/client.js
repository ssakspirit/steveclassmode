/**
 * Steve Classroom Mode - 웹 클라이언트 (Minimalist Theme)
 */

// ==================== 전역 상태 ====================

let ws = null;
let players = new Map();
let reconnectAttempts = 0;
let hostPlayerName = null;   // 모드 전환 명령어에서 호스트(선생님) 제외 대상 필터링용
let isMinecraftConnected = false;  // 토글 관제 진위: MC 연결 여부
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
    };
  } catch (error) {
    console.error('설정 로드 실패:', error);
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

      // 이미 마인크래프트가 연결되어 있는 상태에서 대시보드에 접구
      isMinecraftConnected = message.data.connected;
      updateHostUI();
      
      if (message.data.hostPlayerName) {
        hostPlayerName = message.data.hostPlayerName;
      }
      
      if (message.data.players) {
        message.data.players.forEach(player => {
          players.set(player.name, player);
        });
        updatePlayerList();
      }
      break;

    case 'event':
      // 마인크래프트 이벤트 무시 (미니멀리즘 테마)
      break;

    case 'host_assigned':
      hostPlayerName = message.data.name;
      break;

    case 'player_join':
      players.set(message.data.name, message.data);
      updatePlayerList();
      break;

    case 'player_leave':
      const player = players.get(message.data.name);
      if (player) {
        player.isConnected = false;
        updatePlayerList();
      }
      break;

    case 'player_move':
      const movedPlayer = players.get(message.data.name);
      if (movedPlayer) {
        if (message.data.position) movedPlayer.position = message.data.position;
        if (message.data.dimension) movedPlayer.dimension = message.data.dimension;
        updatePlayerList();
      }
      break;

    case 'player_chat':
      if (message.data) {
        addChatMessage(message.data.player, message.data.message);
      }
      break;

    case 'command_response':
      break;

    case 'minecraft_connected':
      console.log('🎮 마인크래프트가 서버에 연결되었습니다!');
      isMinecraftConnected = true;
      updateHostUI();
      break;

    case 'minecraft_disconnected':
      console.log('⚠️ 마인크래프트 연결이 끊어졌습니다.');
      isMinecraftConnected = false;
      hostPlayerName = null;
      updateHostUI();
      players.forEach(p => p.isConnected = false);
      updatePlayerList();
      break;

    default:
      console.log('알 수 없는 메시지 타입:', message.type);
  }
}

// ==================== UI 업데이트 ====================

function updateConnectionStatus(connected) {
  const statusText = document.getElementById('connection-status');
  const statusDot = document.getElementById('status-dot');

  if (connected) {
    statusText.textContent = '연결됨';
    statusText.style.color = '#55ff55';
    statusDot.classList.add('connected');
  } else {
    statusText.textContent = '연결 끊김';
    statusText.style.color = '#ff5555';
    statusDot.classList.remove('connected');
  }
}

function updatePlayerList() {
  const playerList = document.getElementById('player-list');
  const playerCount = document.getElementById('player-count');

  const onlineStudents = Array.from(players.values()).filter(p => p.isConnected && p.name !== hostPlayerName);
  if (playerCount) playerCount.textContent = `학생: ${onlineStudents.length}명`;

  if (players.size === 0) {
    playerList.innerHTML = '<div class="empty-state">학생이 없습니다.</div>';
    return;
  }

  playerList.innerHTML = '';
  Array.from(players.entries())
    .filter(([, player]) => player.isConnected)   // 퇴장한 플레이어 제외
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, player]) => {
      const item = document.createElement('div');
      item.className = 'player-card';
      item.innerHTML = `<div class="player-name">${name === hostPlayerName ? '👩‍🏫 ' : ''}${name}</div>`;

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlayerContextMenu(e.clientX, e.clientY, name);
      });

      playerList.appendChild(item);
    });
}

// ==================== 명령 전송 ====================

// 채팅로그에 메시지 추가
function addChatMessage(playerName, message) {
  const log = document.getElementById('chat-log');
  if (!log) return;

  const line = document.createElement('div');
  const isHost = playerName === hostPlayerName || playerName === '교사';
  const color = isHost ? '#ffff55' : (playerName ? '#55ffff' : '#aaa');
  // < > 를 HTML 엔티티로 이스케이프 → 브라우저가 태그로 오인하지 않음
  const prefix = playerName ? `&lt;${playerName}&gt; ` : '';
  line.innerHTML = `<span style="color:${color}">${prefix}${message}</span>`;
  log.appendChild(line);

  log.scrollTop = log.scrollHeight;
}

// 웹에서 마인크래프트로 메시지/커맨드 전송
function sendChat(text) {
  if (!text || !text.trim()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('서버에 연결되지 않아 전송 불가');
    return;
  }
  ws.send(JSON.stringify({ type: 'say', text: text.trim() }));
  // 마인크래프트가 PlayerMessage 이벤트로 돌려보내므로 로컬 표시 불필요 (중복 방지)
}

function sendCommand(cmdStr) {
  if (!cmdStr) return;

  // WebSocket으로 전송
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'command',
      command: cmdStr
    };
    
    console.log('📤 [명령어 전송 시도]:', JSON.stringify(payload));
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('서버에 연결되지 않아 명령을 전송할 수 없습니다.');
  }
}

// ==================== 주의 집중 (월드 퍼즈 토글) ====================

function updateHostUI() {
  if (isMinecraftConnected) {
    document.body.classList.remove('host-offline');
  } else {
    document.body.classList.add('host-offline');
  }
}

function toggleWorldPause() {
  const toggleInput = document.getElementById('toggle-world-pause');
  
  if (!isMinecraftConnected) {
    alert('마인크래프트와 연결되지 않았습니다. 메입니다. /connect localhost:3000 을 먼저 실행해주세요.');
    toggleInput.checked = !toggleInput.checked;
    return;
  }

  const toggleText = document.getElementById('toggle-text-status');
  // 월드 변경 불가 스위치 연동용
  const immutableInput = document.getElementById('toggle-immutable');
  const immutableText = immutableInput ? immutableInput.closest('.mc-settings-row').querySelector('.toggle-text') : null;

  isWorldPaused = toggleInput.checked;

  if (isWorldPaused) {
    // 주의 집중 켜기 (disabled = 얼리기)
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] movement disabled`);
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] camera disabled`);
    sendCommand(`/immutableworld true`);
    sendCommand(`/tellraw @a {"rawtext":[{"text":"§c[알림] 플레이를 잠시 중단합니다. 잠시 선생님께 집중해주세요."}]}`);
    
    // UI 업데이트
    if (toggleText) toggleText.style.color = '#55ff55';
    if (immutableInput) {
      immutableInput.checked = true;
      if (immutableText) immutableText.style.color = '#55ff55';
    }
    console.log(`⏸️ 주의 집중 켜짐 (${hostPlayerName} 제외) 및 월드 변경 불가 적용`);
  } else {
    // 주의 집중 끄기 (enabled = 해제)
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] movement enabled`);
    sendCommand(`/inputpermission set @a[name=!"${hostPlayerName}"] camera enabled`);
    sendCommand(`/immutableworld false`);
    sendCommand(`/ability "${hostPlayerName}" mayfly true`);
    sendCommand(`/tellraw @a {"rawtext":[{"text":"§a[알림] 플레이가 재개되었습니다."}]}`);
    
    // UI 업데이트
    if (toggleText) toggleText.style.color = '#fff';
    if (immutableInput) {
      immutableInput.checked = false;
      if (immutableText) immutableText.style.color = '#fff';
    }
    console.log(`▶️ 주의 집중 꺼짐 및 월드 변경 불가 해제`);
  }
}

// 7종 신규 클래스룸 설정 토글 핸들러
function toggleSetting(type) {
  const toggleInput = document.getElementById(`toggle-${type}`);
  
  if (!isMinecraftConnected) {
    alert('마인크래프트와 연결되지 않았습니다. /connect localhost:3000 을 먼저 실행해주세요.');
    toggleInput.checked = !toggleInput.checked;
    return;
  }

  const isChecked = toggleInput.checked;
  const toggleText = toggleInput.closest('.mc-settings-row').querySelector('.toggle-text');

  // UI 글자색 변경 피드백
  toggleText.style.color = isChecked ? '#55ff55' : '#fff';

  switch (type) {
    case 'tnt':
      // TNT 금지 (켜지면 폭발 무시 false, 꺼지면 폭발 허용 true)
      sendCommand(`/gamerule tntexplodes ${isChecked ? 'false' : 'true'}`);
      console.log(`TNT 폭발: ${isChecked ? '금지됨' : '허용됨'}`);
      break;

    case 'mobs':
      // 몹 금지 (켜지면 스폰 false 및 기존 몹 제거, 꺼지면 스폰 true)
      sendCommand(`/gamerule domobspawning ${isChecked ? 'false' : 'true'}`);
      if (isChecked) {
        // 이미 소환되어 있는 플레이어를 제외한 모든 엔티티(몹, 아이템 등) 제거
        sendCommand(`/kill @e[type=!player]`);
        console.log(`기존 몹 제거 및 스폰 금지됨`);
      } else {
        console.log(`몹 스폰 허용됨`);
      }
      break;

    case 'pvp':
      // PvP 금지 (켜지면 PvP false, 꺼지면 PvP true)
      sendCommand(`/gamerule pvp ${isChecked ? 'false' : 'true'}`);
      console.log(`PvP: ${isChecked ? '금지됨' : '허용됨'}`);
      break;

    case 'weather':
      // 낮과 날씨 맑음 항상 유지
      if (isChecked) {
        sendCommand(`/time set day`);
        sendCommand(`/weather clear`);
        sendCommand(`/gamerule dodaylightcycle false`);
        sendCommand(`/gamerule doweathercycle false`);
        console.log(`낮/날씨 강제 고정 켜짐`);
      } else {
        sendCommand(`/gamerule dodaylightcycle true`);
        sendCommand(`/gamerule doweathercycle true`);
        console.log(`낮/날씨 강제 고정 꺼짐`);
      }
      break;

    case 'immutable':
      // 월드 변경 불가 (블록 파괴/설치 불가)
      sendCommand(`/immutableworld ${isChecked ? 'true' : 'false'}`);
      console.log(`월드 변경 불가: ${isChecked}`);
      break;

    case 'flight':
      // 비행 능력 (호스트를 제외한 학생들 비행 허용)
      sendCommand(`/ability @a[name=!"${hostPlayerName}"] mayfly ${isChecked ? 'true' : 'false'}`);
      console.log(`학생 비행 능력 부여: ${isChecked}`);
      break;

    case 'creative':
      // 크리에이티브 전환 (호스트 제외 전체)
      sendCommand(`/gamemode ${isChecked ? 'c' : 's'} @a[name=!"${hostPlayerName}"]`);
      console.log(`전체 학생 크리에이티브 모드: ${isChecked}`);
      break;
  }
}

// ==================== 우클릭 컨텍스트 메뉴 ====================

let contextTargetPlayer = null;

function showPlayerContextMenu(x, y, playerName) {
  contextTargetPlayer = playerName;
  const menu = document.getElementById('player-context-menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add('visible');
}

function hideContextMenu() {
  const menu = document.getElementById('player-context-menu');
  menu.classList.remove('visible');
  contextTargetPlayer = null;
}

// ==================== 초기화 ====================

document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Steve Classroom Mode 클라이언트 시작');
  connect();

  // 컨텍스트 메뉴 버튼 동작
  document.getElementById('ctx-tp').addEventListener('click', () => {
    if (contextTargetPlayer) {
      sendCommand(`/tp @s "${contextTargetPlayer}"`);
      console.log(`📍 텔레포트 → ${contextTargetPlayer}`);
    }
    hideContextMenu();
  });

  document.getElementById('ctx-tphere').addEventListener('click', () => {
    if (contextTargetPlayer) {
      sendCommand(`/tp "${contextTargetPlayer}" @s`);
      console.log(`↩️ 소환 ← ${contextTargetPlayer}`);
    }
    hideContextMenu();
  });

  // 다른 곳 클릭 시 메뉴 닫기
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', (e) => {
    // player-list 외부 우클릭 시 기본 동작 허용 + 메뉴 닫기
    if (!e.target.closest('#player-list')) {
      hideContextMenu();
    }
  });

  // ==================== 채팅 입력창 ====================
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  function submitChat() {
    const text = chatInput.value;
    if (!text.trim()) return;
    sendChat(text);
    chatInput.value = '';
  }

  chatSend.addEventListener('click', submitChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitChat();
  });

  // 자주 쓰는 명령어 초기화
  initQuickCmds();
});

// ==================== 자주 쓰는 명령어 ====================
let currentEditCmdId = null;

function getQuickCmd(id) {
  const data = localStorage.getItem(`quickCmd_${id}`);
  if (data) {
    try {
      return JSON.parse(data);
    } catch(e) {}
  }
  return { name: '', cmd: '' };
}

function setQuickCmd(id, name, cmd) {
  localStorage.setItem(`quickCmd_${id}`, JSON.stringify({ name, cmd }));
}

function initQuickCmds() {
  for (let i = 1; i <= 5; i++) {
    updateQuickCmdButton(i);
  }
}

function updateQuickCmdButton(id) {
  const btn = document.getElementById(`qbtn-${id}`);
  if (!btn) return;
  const data = getQuickCmd(id);
  
  if (data.name && data.cmd) {
    btn.textContent = data.name;
    btn.title = data.cmd;
    btn.disabled = false;
  } else {
    btn.textContent = '(비어 있음)';
    btn.title = '우측 연필 아이콘을 눌러 설정하세요';
    btn.disabled = true;
  }
}

window.runQuickCmd = function(id) {
  const data = getQuickCmd(id);
  if (data.cmd) {
    // 슬래시로 시작하면 샌드커맨드, 아니면 채팅 전송
    if (data.cmd.startsWith('/')) {
      sendCommand(data.cmd);
      console.log(`⚡ 명령어 실행: ${data.cmd}`);
    } else {
      sendChat(data.cmd);
      console.log(`⚡ 텍스트 전송: ${data.cmd}`);
    }
  }
};

window.editQuickCmd = function(id) {
  currentEditCmdId = id;
  const data = getQuickCmd(id);
  const modal = document.getElementById('quick-cmd-modal');
  document.getElementById('qcmd-name-input').value = data.name || '';
  document.getElementById('qcmd-cmd-input').value = data.cmd || '';
  modal.classList.add('visible');
  document.getElementById('qcmd-name-input').focus();
};

window.saveQuickCmd = function() {
  if (currentEditCmdId === null) return;
  const name = document.getElementById('qcmd-name-input').value.trim();
  const cmd = document.getElementById('qcmd-cmd-input').value.trim();
  
  setQuickCmd(currentEditCmdId, name, cmd);
  updateQuickCmdButton(currentEditCmdId);
  closeQuickCmdModal();
};

window.closeQuickCmdModal = function() {
  const modal = document.getElementById('quick-cmd-modal');
  modal.classList.remove('visible');
  currentEditCmdId = null;
};
