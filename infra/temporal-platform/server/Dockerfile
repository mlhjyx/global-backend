FROM docker.io/temporalio/server@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da AS runtime-base

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS source
WORKDIR /src
COPY scripts/temporal-native-publication.mjs ./scripts/temporal-native-publication.mjs
COPY scripts/temporal-native-publication-sbom.mjs ./scripts/temporal-native-publication-sbom.mjs
COPY infra/temporal-platform ./infra/temporal-platform
ARG BUILD_SHA
ARG SOURCE_DIGEST
RUN node scripts/temporal-native-publication.mjs source /src "$BUILD_SHA" > /source.json && \
    node -e 'const fs=require("fs"); if(JSON.parse(fs.readFileSync("/source.json")).sourceDigest!==process.argv[1])process.exit(1)' "$SOURCE_DIGEST"

FROM docker.io/library/golang@sha256:ab3d6955bbc813a0f3fdf220c1d817dd89c0b3f283777db8ece4a32fe7858edd AS build
ENV GOTOOLCHAIN=go1.26.4
ENV GOMAXPROCS=2
WORKDIR /src
COPY --from=source /src/infra/temporal-platform/server/go.mod /src/infra/temporal-platform/server/go.sum ./
# The exact toolchain and modules are checksum verified before offline compile.
RUN go mod download && go mod verify
COPY --from=source /src/infra/temporal-platform/server/readerpolicy ./readerpolicy
COPY --from=source /src/infra/temporal-platform/server/cmd ./cmd
# Native business tests remain in required CI; publication compiles the same
# implementation without executing a second test matrix inside the image build.
RUN --network=none CGO_ENABLED=0 go build -mod=readonly -p 2 -trimpath -buildvcs=false -o /out/temporal-server ./cmd/server
RUN --network=none go version -m -json /out/temporal-server > /out/go-build-info.json

FROM source AS artifact
COPY --from=build /out/temporal-server /native-binary
COPY --from=build /out/go-build-info.json /go-build-info.json
COPY --from=runtime-base /lib/apk/db/installed /apk-installed
RUN node scripts/temporal-native-publication.mjs sbom /source.json /native-binary /go-build-info.json /apk-installed > /sbom.cdx.json && \
    node scripts/temporal-native-publication.mjs artifact /source.json /native-binary /go-build-info.json /apk-installed /sbom.cdx.json > /manifest.json

FROM runtime-base
ARG BUILD_SHA
ARG SOURCE_DIGEST
LABEL org.opencontainers.image.revision=$BUILD_SHA \
      org.opencontainers.image.source="https://github.com/mlhjyx/global-backend" \
      io.global.temporal.native.source-digest=$SOURCE_DIGEST \
      io.global.temporal.native.role="native-reader-authorization"
USER root
COPY --from=build --chmod=0555 /out/temporal-server /usr/local/bin/temporal-server
COPY --from=artifact --chmod=0444 /manifest.json /opt/temporal-platform-release/manifest.json
COPY --from=artifact --chmod=0444 /sbom.cdx.json /opt/temporal-platform-release/sbom.cdx.json
COPY --from=build --chmod=0444 /out/go-build-info.json /opt/temporal-platform-release/go-build-info.json
COPY --from=source --chmod=0444 /src/infra/temporal-platform/config/temporal.yaml /opt/temporal-platform-release/config/temporal.yaml
COPY --from=source --chmod=0444 /src/infra/temporal-platform/config/dynamicconfig.yaml /opt/temporal-platform-release/config/dynamicconfig.yaml
COPY --from=source --chmod=0444 /src/infra/temporal-platform/roles.json /opt/temporal-platform-release/roles.json
USER 1000:1000
# Keep the pinned upstream entrypoint's address/broadcast handling. Its only
# dispatch is `temporal-server start`, implemented by the native wrapper above.
CMD ["/etc/temporal/entrypoint.sh"]
