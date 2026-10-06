FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web-server/package.json packages/web-server/package.json
COPY packages/web-client/package.json packages/web-client/package.json
COPY packages/vscode-extension/package.json packages/vscode-extension/package.json
COPY packages/vscode-extension/webview-ui/package.json packages/vscode-extension/webview-ui/package.json

RUN npm ci

COPY . .

RUN npm run build:web-client

ENV PORT=4600
# The server listens on loopback by default; inside a container that would be unreachable from outside it.
ENV FINANFA_WEB_HOST=0.0.0.0
EXPOSE 4600

CMD ["npm", "run", "start", "-w", "@finanfa/web-server"]
