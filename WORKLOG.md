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

---

## 📝 변경 이력

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
