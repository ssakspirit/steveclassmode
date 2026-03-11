# Steve Classroom Mode 빌드 가이드

이 문서는 Steve Classroom Mode(웹소켓 기반 마인크래프트 교육용 대시보드)를 일반 사용자가 더블 클릭만으로 실행할 수 있는 **단일 `.exe` 실행 파일**로 빌드(배포)하는 방법을 설명합니다.

---

## 🏗️ 빌드 원리 (pkg)
이 프로젝트는 Node.js 런타임 환경에서 작동합니다. 
일반 사용자의 PC에는 Node.js가 설치되어 있지 않을 수 있으므로, Vercel에서 만든 **[pkg](https://github.com/vercel/pkg)** 라는 라이브러리를 사용하여 "Node.js 엔진 + 서버 스크립트(`server.js`) + 대시보드 웹 파일(`public/` 폴더)"을 모두 하나의 `.exe` 파일 내부 가상 공간에 통째로 압축해 넣습니다.

## ⚙️ 빌드 사전 설정 (package.json)
`pkg`가 실행 파일을 만들 때 어떤 파일들을 포함해야 하는지 알려주어야 합니다. `package.json` 파일에 아래와 같은 설정이 포함되어 있어야 합니다.

```json
{
  "main": "dist/server.js",     // 프로그램이 시작될 엔트리 포인트 (필수)
  "bin": "dist/server.js",      // pkg가 실행할 메인 파일 (필수)
  "scripts": {
    "build:exe": "npx tsc && npx pkg . --targets node18-win-x64 --output steve-classroom-mode.exe"
  },
  "pkg": {
    "scripts": "dist/**/*.js",  // 컴파일될 JS 소스코드 포함
    "assets": [
      "public/**/*"             // HTML, CSS, 로고 등 정적 웹 파일 포함
    ]
  }
}
```

## 🚨 개발 시 주의사항 (코드 작성 규칙)
`pkg`로 압축된 런타임 환경에서는 코드가 **가상의 읽기 전용(Read-Only) 파일 시스템** 안에서 구동됩니다.
따라서 서버 코드를 작성할 때 파일 저장(로그 저장, 파일 쓰기 등) 경로를 설정할 때 주의가 필요합니다.

*   **❌ 잘못된 예 (`__dirname`):** 
    `path.join(__dirname, 'logs')` 처럼 작성하면 `.exe` 내부의 가상 폴더 기준이 되어, 프로그램이 폴더를 생성하지 못하고 접근 권한 오류로 강제 종료(Crash)됩니다.
*   **✅ 올바른 예 (`process.cwd()`):** 
    `path.join(process.cwd(), 'logs')` 처럼 작성하면, **사용자가 `.exe` 파일을 더블클릭해서 실행한 실제 윈도우 바탕화면/탐색기 기준 로컬 경로**를 잡아주어 안전하게 파일(로그 등)을 저장하고 읽을 수 있습니다.

---

## 🚀 실행 파일(.exe) 생성 방법

빌드 준비가 끝났다면 컴파일러 터미널(PowerShell 등)을 열고 아래 명령어를 딱 한 줄만 입력하면 됩니다.

### 1단계: 빌드 스크립트 실행
```bash
npm run build:exe
```
(이 명령어는 TypeScript 코드를 먼저 자바스크립트로 변환(`tsc`)한 뒤, `pkg` 라이브러리를 통해 윈도우용 실행 파일을 한 덩어리로 묶어냅니다.)

### 2단계: 결과물 확인
약 1~2분의 묶음(Fetching base Node.js binaries) 작업이 끝나면, 현재 프로젝트 폴더에 아래 경로로 약 **45MB~50MB 내외의 단일 실행 파일**이 새로 생성됩니다.

*   **출력 파일:** `steve-classroom-mode.exe`

### 3단계: 배포 (끝)
기존의 `src/`, `node_modules/`, 프로그램 소스코드 전체를 압축해서 보낼 필요가 **전혀 없습니다.**
오직 하나 툭 튀어나온 **`steve-classroom-mode.exe`** 파일 단 한 개만 USB에 담거나 카카오톡으로 다른 선생님들께 공유하면 됩니다.

받은 선생님은 윈도우 환경에서 해당 **파일을 더블 클릭**하기만 하면, 복잡한 설치 과정이나 터미널 창 없이 즉시 마인크래프트 서버와 대시보드 웹페이지가 자동으로 열립니다!
