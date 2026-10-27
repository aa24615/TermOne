#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_VERSION:?}"
: "${RELEASE_TAG:?}"
: "${RELEASE_SHA:?}"
: "${GH_REPO:?}"
[[ "$RELEASE_TAG" == "v$RELEASE_VERSION" ]]
cd release-assets
for arch in aarch64 x64; do
  test -s "TermOne_${RELEASE_VERSION}_${arch}.dmg"
  test -s "TermOne_${RELEASE_VERSION}_${arch}.app.zip"
  test -s "TermOne_${RELEASE_VERSION}_${arch}.sha256"
done
sha256sum -c ./*.sha256
cat ./*.sha256 > SHA256SUMS.txt
cat > release-notes.md <<EOF
## macOS 安装包

- Apple Silicon（M1/M2/M3/M4 等）：下载文件名含 aarch64 的 DMG。
- Intel Mac：下载文件名含 x64 的 DMG。
- 打开 DMG，将 TermOne 拖入 Applications；也可使用对应架构的 app.zip。
- SHA256SUMS.txt 提供全部安装包的 SHA-256 校验值。

本版本从 main 的提交 ${RELEASE_SHA} 构建，包含多软件 SSH 配置导入、插件与独立应用管理、侧栏拖动调整、终端标题栏分离和无边框命令行区域。

应用采用 ad-hoc 签名并通过本机签名及 DMG 完整性检查，尚未进行 Apple Developer 签名或公证。首次打开可能需要在 macOS「隐私与安全性」中确认。

由 GitHub Actions 构建并发布。版本：${RELEASE_TAG}。
EOF
if gh release view "$RELEASE_TAG" --json isDraft > existing-release.json 2>/dev/null; then
  node -e 'if (!require("./existing-release.json").isDraft) throw Error("该版本已公开发布，不能覆盖；请创建新版本")'
else
  gh release create "$RELEASE_TAG" --verify-tag --draft --title "TermOne $RELEASE_TAG" --notes-file release-notes.md
fi
gh release upload "$RELEASE_TAG" ./*.dmg ./*.app.zip SHA256SUMS.txt --clobber
# All architectures and checksums are uploaded before making the release public.
gh release edit "$RELEASE_TAG" --draft=false --latest --title "TermOne $RELEASE_TAG" --notes-file release-notes.md
gh release view "$RELEASE_TAG" --json url,assets --jq '{url,assets:[.assets[]|{name,size}]}'
