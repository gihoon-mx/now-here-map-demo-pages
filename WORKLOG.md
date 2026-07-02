# WORKLOG — now-here-map-demo-pages

> 여러 PC를 오가며 작업하기 위한 **단일 상태 소스**입니다.
> 새 PC에서 시작할 때 이 파일을 먼저 읽고, 작업을 마치면 아래 규칙대로 갱신·push 하세요.

---

## 🔁 다른 PC에서 이어가기 (매번 이 순서)

```bash
# 1) 최신 상태 받기 (작업 시작 전 항상)
git pull

# 2) ...작업...

# 3) 작업 끝나면: WORKLOG 갱신 → 커밋 → push
git add -A
git commit -m "작업 내용 요약 vX.Y.Z"
git push
```

- **push 전 반드시 `git pull`** 먼저 (다른 PC에서 올린 변경과 충돌 방지).
- 이 repo는 **`main` 브랜치 루트에서 GitHub Pages 자동 배포**됨 → main에 push하면 1~2분 뒤 배포 반영.
- 배포 URL: **https://gihoon-mx.github.io/now-here-map-demo-pages/**

### 🔢 버전 규칙 (코드/스타일 바꿀 때마다 필수)
제작(코드·스타일·기능 변경)마다 버전을 올리고 **3곳을 동기화**:
1. `index.html` → `<span id="app-version">vX.Y.Z</span>`
2. asset 캐시버스트 → `style.css?v=X.Y.Z`, `app.js?v=X.Y.Z`, `config.js?v=X.Y.Z`
3. 커밋 메시지에 `vX.Y.Z`
- 증가: 일반 변경 = 패치(+0.0.1), 큰 기능 = 마이너(+0.1.0). 문서(WORKLOG 등)만 바뀌면 버전 유지.
- **현재 최신: v1.4.0**

---

## 🔐 계정 / 인증 (중요)

- GitHub repo 소유: **`gihoon-mx`** (2026-07-02에 `gihoonmx-source`에서 rename됨).
- 이 Mac은 gh CLI에 계정 2개가 있음. **push하려면 gihoon-mx가 active여야 함**:
  ```bash
  gh auth switch --user gihoon-mx     # 이 프로젝트 작업 시
  # (HAOS 등 shoomerion 작업으로 돌아갈 땐 gh auth switch --user shoomerion)
  ```
- 커밋 identity(로컬 repo 한정): `gihoon-mx <gihoon.mx@gmail.com>`.
  - 새 PC에서 clone 후 필요하면:
    ```bash
    git config user.name "gihoon-mx"
    git config user.email "gihoon.mx@gmail.com"
    ```

---

## 🗂️ 프로젝트 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 진입점 |
| `app.js` | 앱 로직 (지도, 로그인, 관리자 뷰 등) |
| `style.css` | 스타일 |
| `config.js` | 설정값 (Maps/Firebase 키, ADMIN_EMAIL 등) |
| `firestore.rules` | Firestore 보안 규칙 (소스 오브 트루스 — 콘솔과 동기화 유지) |
| `dong_boundary.geojson` | 동 단위 행정구역 경계 데이터 |

---

## ☁️ 외부 설정 (코드 밖 — GCP/Firebase 콘솔)

계정: `gihoon.mx@gmail.com` / GCP 프로젝트 2개

- **`now-here-demo`**: Firebase 프로젝트. Firebase 브라우저 키, OAuth 웹 클라이언트, Firebase Authentication(Google 로그인).
- **`hot-hot-map`**: Maps Platform API 키.

⚠️ **배포 도메인(github.io)이 바뀌면** 아래 4곳에 새 도메인을 추가해야 지도·로그인이 안 깨짐:
1. now-here-demo → Firebase 브라우저 키 · HTTP 리퍼러
2. now-here-demo → OAuth 웹 클라이언트 · 승인된 JavaScript 원본
3. hot-hot-map → Maps Platform 키 · HTTP 리퍼러
4. Firebase Console → Authentication → Settings → **승인된 도메인**

⚠️⚠️ **Firebase 브라우저 키(1번)의 HTTP 리퍼러에는 앱 도메인과 별개로 아래가 항상 있어야 함** (없으면 Google 로그인이 403 `API_KEY_HTTP_REFERRER_BLOCKED` → "The requested action is invalid."로 깨짐. 로그인 팝업이 이 도메인에서 돌기 때문):
- `https://now-here-demo.firebaseapp.com/*`
- `https://now-here-demo.web.app/*`

### Firestore 규칙
- 소스 오브 트루스: repo의 **`firestore.rules`**. 콘솔(Firebase → Firestore → 규칙)에 배포하며, 양쪽을 항상 같게 유지.
- 규칙의 관리자 이메일(`gihoon.mx@gmail.com`)은 `config.js`의 `ADMIN_EMAIL`과 일치해야 함.

---

## 📝 변경 이력

### 2026-07-03
- **v1.4.0 — 사이드바/폰/역할/모바일 4종 개선**:
  - **사이드바 폭 드래그 조절**(map↔sidebar 사이 `#sidebar-resizer`) → 폰 크기 변경. 폰 내부 UI는 `.phone-screen`을 `container-type:inline-size`로 만들고 상태바/앱바/네비를 **cqw 단위**로 바꿔 **폭이 바뀌어도 비율 유지**. 폭은 localStorage(`nowhere_sidebarW`) 저장.
  - **폰 하단 네비 정리**: navbar/그룹/아이템/AI를 cqw 기반으로 일관 정리.
  - **데모유저(role='user') 뷰어 모드**: 로그인 시 지도 부팅 + 로컬/트렌드 토글만 가능, 설정·존편집·allowlist UI는 `body.role-user`로 숨김, 헥사곤 선택(`toggleHex`) 차단. (클라우드 로드/저장 없음)
  - **모바일(≤768px) 접속 시 폰 화면만 전체표시**: map/패널 숨김, `.phone-screen`이 뷰포트 채움. 모바일에선 폰 지도 `gestureHandling:'greedy'`로 상호작용 가능.
- **레이아웃 재정의 v1.3.0**: 관리자 화면을 2컬럼으로 분리. **왼쪽=전체화면 지도만**, **오른쪽=사이드바**(상단: 폰 화면(프레임/레일 제거), 하단: 컨트롤/설정 패널). 기존 플로팅 폰 미러/좌측 플로팅 패널 → 사이드바에 도킹. HTML `#app-shell`(flex)+`#sidebar`, CSS만 변경. 폰 컨트롤 JS(드래그/크기/접기)는 요소 제거해도 방어적 가드라 무변경. 캐시버스트 `?v=1.3.0`.
  - TODO(후속): 폰 위 저장/뷰상태, 사이드바 폭 조절, 데모유저 화면 등.
- **Google 로그인 복구**: Firebase 브라우저 키 리퍼러에 `now-here-demo.firebaseapp.com`(+`web.app`)이 빠져 403으로 로그인이 깨졌던 것 → 리퍼러 추가로 해결 (위 ⚠️⚠️ 참고).
- **Firestore 규칙을 repo로 편입**: `firestore.rules` 추가. 기존 `allow read,write: if false`(전면 차단)에서 → 로그인/allowlist/유저데이터 접근을 실제 앱 패턴에 맞춰 허용하는 규칙으로 교체(콘솔 배포). allowlist(본인 문서 읽기/관리자 관리) + users/{uid}(관리자 본인 데이터) 구조.

### 2026-07-02
- **GitHub username 변경: `gihoonmx-source` → `gihoon-mx`.**
  - 배포 URL이 `gihoon-mx.github.io/now-here-map-demo-pages/`로 변경 (옛 주소는 404).
  - 위 외부 설정 4곳에 `gihoon-mx.github.io` 도메인 추가 완료.
  - 로컬 remote를 새 주소로 갱신 완료.
- 이 `WORKLOG.md` 추가 (cross-machine 작업 연속성용).

### ~v1.2.0 (기존 커밋 히스토리 참고)
- Google 로그인 + 계정 저장/접근제어 (Firebase)
- 관리자 뷰포트 오버레이 / 폰 미러 / AI 캐릭터 등
- 자세한 내역은 `git log --oneline` 참고.

---

## ✅ 다음 작업 (TODO)

_(여기에 진행 중/다음 할 일을 적어두면 다른 PC에서 바로 이어갈 수 있음)_

- [ ]
