let ws = null;
let commandString = '';

window.onload = async () => {
    const btnCopy = document.getElementById('btn-copy');
    const commandText = document.getElementById('command-text');
    const statusText = document.getElementById('status-text');

    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        commandString = `/connect localhost:${config.wsPort}`;

        commandText.textContent = commandString;
        statusText.textContent = '';

        // 자동 복사 시도
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(commandString);
                btnCopy.textContent = '✅ 복사 완료! 게임에서 (Ctrl+V) 하세요.';
                btnCopy.style.background = '#059669';
            }
        } catch (e) {
            console.warn('자동 복사 실패, 사용자가 직접 눌러야 합니다.');
        }

        // 웹소켓 연결
        connectWebSocket(config.wsPort);

    } catch (error) {
        statusText.textContent = '서버 설정 로드 실패. 다시 시작해주세요.';
        commandText.textContent = '오류 발생';
    }

    btnCopy.onclick = async () => {
        try {
            if (commandString) {
                await navigator.clipboard.writeText(commandString);
                btnCopy.textContent = '✅ 복사 완료! 게임에서 (Ctrl+V) 하세요.';
                btnCopy.style.background = '#059669';
                setTimeout(() => {
                    btnCopy.textContent = '📋 명령어 자동 복사';
                    btnCopy.style.background = '#10b981';
                }, 3000);
            }
        } catch (err) {
            alert('자동 복사를 지원하지 않는 환경입니다. 명령어를 직접 드래그하여 복사해주세요.');
        }
    };
};

function connectWebSocket(port) {
    const wsUrl = `ws://${window.location.hostname}:${port}/web`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Setup 화면 웹소켓 연결 완료');
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'init') {
            if (message.data.connected) {
                // 이미 연결되어 있다면 대시보드로 이동
                window.location.href = '/index.html';
            }
        } else if (message.type === 'minecraft_connected') {
            // 마인크래프트가 방금 연결됨
            window.location.href = '/index.html';
        }
    };

    ws.onclose = () => {
        console.log('웹소켓 연결 끊김, 재시도 필요');
        setTimeout(() => connectWebSocket(port), 3000);
    };
}
