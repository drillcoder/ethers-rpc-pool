FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG EXPECTED_NODE_VERSION=22.23.2

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN PACKAGE_MANAGER="$(node --print "require('./package.json').packageManager")" \
    && EXPECTED_NPM_VERSION="${PACKAGE_MANAGER#npm@}" \
    && test "$(node --version)" = "v${EXPECTED_NODE_VERSION}" \
    && test "${PACKAGE_MANAGER}" = "npm@${EXPECTED_NPM_VERSION}" \
    && npm install --global "${PACKAGE_MANAGER}" \
    && test "$(npm --version)" = "${EXPECTED_NPM_VERSION}"

RUN npm ci

COPY . .

CMD ["npm", "run", "quality"]
