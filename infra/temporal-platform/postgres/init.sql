CREATE DATABASE temporal_platform_visibility OWNER temporal_platform;

REVOKE CONNECT ON DATABASE temporal_platform FROM PUBLIC;
REVOKE CONNECT ON DATABASE temporal_platform_visibility FROM PUBLIC;
GRANT CONNECT ON DATABASE temporal_platform TO temporal_platform;
GRANT CONNECT ON DATABASE temporal_platform_visibility TO temporal_platform;
