/// <reference types="vitest/config" />
import { defineConfig, type Rolldown } from 'vite';
import react from '@vitejs/plugin-react';
import { skinotePwa } from './pwa/skinote-pwa.ts';

/** 첫 화면의 정적 가져오기 사슬은 업무 화면 묶음으로 옮기지 않는다. 순환 가져오기도 한 번씩만 본다. */
function isInitialModule(id: string, context: Rolldown.ChunkingContext, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const info = context.getModuleInfo(id);
  return Boolean(info && (info.isEntry || info.importers.some(parent => isInitialModule(parent, context, seen))));
}

// 상대 주소와 해시 경로로 체험판의 /skinote/ 하위 경로와 매장 서버에서 같은 빌드를 쓴다.
// skinotePwa는 빌드한 앱과 글꼴의 목록 · 내용 해시로 manifest.webmanifest와 sw.js를 만든다.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    skinotePwa({
      tokensCss: new URL('../../packages/ui/src/styles/tokens.css', import.meta.url).pathname,
      serviceWorker: new URL('./pwa/sw.js', import.meta.url).pathname,
    }),
  ],
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          // 필요할 때 여는 업무 화면 · 확인창을 함께 압축한다. 공용 의존성과 로그인은 원래 경계를 유지한다.
          includeDependenciesRecursively: false,
          groups: [{
            test: /[\\/]apps[\\/]pos[\\/]src[\\/](screens|components)[\\/]/,
            name(id, context) {
              if (/(Choose|Login|Enroll)Screen\.tsx$/.test(id) || isInitialModule(id, context)) return null;
              return 'workflows';
            },
          }],
        },
      },
    },
  },
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
});
