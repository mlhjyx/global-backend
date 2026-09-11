FROM docker.io/library/golang@sha256:ab3d6955bbc813a0f3fdf220c1d817dd89c0b3f283777db8ece4a32fe7858edd AS build
ENV GOTOOLCHAIN=go1.26.4
WORKDIR /src
COPY go.mod go.sum ./
# The exact toolchain and modules are checksum verified before offline compile.
RUN go mod download && go mod verify
COPY readerpolicy ./readerpolicy
COPY cmd ./cmd
RUN --network=none go test -mod=readonly ./... && CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -o /out/temporal-server ./cmd/server

FROM docker.io/temporalio/server@sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da
USER root
COPY --from=build --chmod=0555 /out/temporal-server /usr/local/bin/temporal-server
USER 1000:1000
# Keep the pinned upstream entrypoint's address/broadcast handling. Its only
# dispatch is `temporal-server start`, implemented by the native wrapper above.
CMD ["/etc/temporal/entrypoint.sh"]
