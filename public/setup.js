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

    const btnLoopback = document.getElementById('btn-loopback');
    if (btnLoopback) {
        btnLoopback.onclick = async () => {
            if (!confirm('베드락 에디션에서 서버에 접속하기 위해 윈도우 네트워크 차단을 해제해야 합니다.\n(이 기능은 "관리자 권한" 팝업을 띄웁니다.)\n\n진행하시겠습니까?')) return;
            try {
                const res = await fetch('/api/loopback-exempt', { method: 'POST' });
                const result = await res.json();
                if (result.success) {
                    alert('성공적으로 로컬 서버 접속 차단을 풀었습니다!\n이제 베드락 에디션에서 명령어를 입력해 보세요.');
                } else {
                    alert('오류 발생: ' + result.error);
                }
            } catch (e) {
                alert('서버 통신 오류가 발생했습니다.');
            }
        };
    }
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
