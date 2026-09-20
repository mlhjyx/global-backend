# Identity GitHub 只读凭据 broker 设计

状态：DRAFT_FOR_INDEPENDENT_REVIEW。用户本轮授权查找与设计说明；本文不授权创建凭据、安装 broker、物化 controller 或执行真实认证请求。

## 1. 现场结论

2026-09-20 只读核查未发现可用的仓库限定 FD broker：会话工具没有对应入口；仓库只有 ROOT_SECRET_STORE / GITHUB_TOKEN_HANDLE 合同及 fixture；计划中的 controllers/github 与 /run/identity-github-credential-broker 均不存在。机器有 /usr/bin/pass，但 /root/.password-store 及 .gpg-id 不存在。systemd-udev-load-credentials.service 是通用系统单元，不是 GitHub broker。

/root/.config/gh/hosts.yml 是 root:root、0600 普通文件。本次没有读取其内容，也没有调用 gh auth token。普通 gh 登录可用不能证明有仓库限定 FD handle，不能据此签发 controller authority receipt。

## 2. 推荐方案：一次性只读 FD broker

使用小型、一次性本机 broker，不引入 Vault、数据库、常驻服务或 provider。
Credential provider 保持 ROOT_SECRET_STORE；其具体适配器为拟建的 `identity-github-readonly-fd/v1`。该名称是设计，不是现有能力。

owner 在独立交互入口提供短期、仅选定 mlhjyx/global-backend 的 fine-grained PAT，权限为 Contents: read 与必要的 Metadata: read，无任何写权限。原始值只进入该 owner 入口与 broker 的内存，编码为匿名 pipe 交给 controller 的指定 FD。禁止从聊天、argv、仓库 .env、普通 gh 配置或 agent 输出中取得原始值；无凭据时 HOLD，不自动回退。

GitHub 的 Get a branch endpoint 支持 fine-grained token 的 Contents: read；凭据创建时还须由 owner 确认资源 owner、唯一选定仓库及到期时间。[GitHub 官方权限文档](https://docs.github.com/en/rest/branches/branches#get-a-branch)

流程为：owner 配置与精确授权 → broker 验证固定请求及 source/tool closure → 向经审查 controller 注入 FD → 两条固定只读观察 → controller 校验一致性 → 排他写入脱敏结果与操作收据 → 独立 readback。

## 3. 封闭作用域与身份

handle 标识采用随机 opaque ID。handleSha256 哈希标识与 broker 身份元数据，不哈希 token。scopeSha256 哈希规范化的封闭作用域记录，至少含：repository、host、credential permission profile、operation=PROTECTED_MAIN_READBACK、requestId、expiresAt、maxCommands=2、writeAllowed=false、controller source/contract digest。

token 的真实 GitHub 端授权范围不能从一个成功的只读调用或本地配置声明推导。owner 的配置证明、GitHub 可获得的读回和本地实际强制范围分别记录；未证明的远端 scope 标 UNKNOWN，不能写成已验证的 GitHub 限权证明。broker 的两条命令 allowlist 独立强制本次访问范围，不能从它推导 token 本身没有其他权限。执行准入还须具备 owner 对新凭据的仓库选择、只读权限、到期时间及 opaque handle 的精确确认；缺失确认、已知存在写权限或 scope 证据互相矛盾均 HOLD。GitHub 端无独立机器读回时，该部分继续记 UNKNOWN，只能依明确记录的 owner 配置确认支持本次限定读取，不能提升成远端限权已验证。

controller 在接收 FD 前验证请求、materialization/review receipt、operator 授权对象的精确 SHA 与有效期，以及 NODE/GIT/GH 的 root-owned 普通文件、realpath、内容 hash、mode 和执行前后 metadata。拒绝 symlink、可写工具、源码/合同漂移和不完整 executable closure。现有 root 不覆写；目标必须符合原计划 create-only 规则。

本机 root/operator 属于受信计算基。FD 不提供对恶意 root 或同权限调试进程的秘密隔离；本方案承诺不把秘密置于仓库、持久文件、命令参数、报告或正常日志。若要求对拥有 root 的 agent 隔离秘密，需另行采用不同主机/受控执行域，不能靠 0600、隐藏环境变量或更换目录名声称完成。

## 4. 唯一允许的物理操作

1. GIT：对固定 HTTPS 仓库 URL 执行 `ls-remote --exit-code --refs`，只读 refs/heads/main。
2. GH：只读固定仓库 branches/main，将 name、commit.sha、protected 投影成单条有界 TSV。

maxCommands=2 只表示两个固定顶层逻辑命令，不声称只有两次 HTTP 交换。执行规格须固定 Git transport/helper 的完整子进程和依赖 closure，明确协议握手/认证交换的网络预算；未冻结前不能安装运行。禁止主动重试整个逻辑命令；客户端内部重试/重定向能力必须通过固定版本与有界 transport 测试证明可控，不能仅从 descriptor 推导零重试或零重定向。

两条观察都必须成功、各恰有一条记录、SHA 相等且 protected=true。否则整体 HOLD；404/权限失败不当作仓库不存在。禁止 fetch、push、PR create/update/merge、tag、branch 删除、workflow rerun 或变量写入。

broker 必须用空白、隔离的 Git/gh HOME/config 和固定可执行文件运行，禁用系统/用户/仓库 credential helper、代理、额外 header、配置 include、debug/trace、交互提示与重定向继承。GIT 认证只进入受控进程内的凭据通道；不得把 token 拼入 URL 或 argv。GH 只能通过受控子进程环境 GH_TOKEN 接收 FD 中的凭据，退出后不保存；controller 的父进程入站环境仍只接受 GITHUB_TOKEN_HANDLE。

GH_TOKEN 是 GitHub CLI 支持的认证接口，GH_CONFIG_DIR 决定配置目录。[GitHub CLI 官方环境说明](https://cli.github.com/manual/gh_help_environment)

因此实现前须明确补充“controller 入站环境”与“broker 子进程秘密环境”的不同合同：允许的子进程环境字段名可记录，字段值禁止进入 receipt。现有 allowedEnvironmentNames 列表不能被静默解释成允许任意 GH_TOKEN、GIT_CONFIG_* 或 inherited HOME。GIT 的具体 FD/helper 适配也必须在执行闭环规格中冻结并审查后再实现。

## 5. 有界执行、重放和输出

每条命令最多15秒，整个请求最多30秒；输出在读取时限制，不能先无界缓冲再检查。stdout 只允许两种固定 TSV，stderr/异常 cause 不透传；child process 超时必须终止并回收。凭据 FD 最多8KiB，只消费一次；空、过大、无 EOF、来源/作用域不明均 HOLD。

请求按稳定 requestId 和 canonical request digest 创建执行记录（create-exclusive、0600、fsync、no-follow），避免多个 executor 同时执行同一请求。结果/receipt 均采用排他创建、fsync 和独立回读。已有 requestId 不重新物理执行；只能读回相同请求的已完成结果。崩溃、部分结果或身份漂移保持 HOLD，不能通过覆盖 receipt 补绿。

receipt 只保存 repository/ref/SHA/protected、源和工具摘要、请求/授权/handle/scope 摘要、执行及观察时间、退出分类和结果摘要。不得保存 token、Authorization、原始 API body、任意 stdout/stderr 或错误对象。local helper 的 OPERATION_RESULT_ONLY/PASS 不等于 materialized-controller receipt，更不等于 ADMITTED。

## 6. 验证与实施顺序

先完成无真实凭据的 RED→GREEN：缺 FD、错误 handle/scope、过期授权、跨仓请求、写操作请求、重放、工具漂移、配置/helper 注入、重复/不一致 SHA、protected=false、超时/超量输出、部分写入和秘密错误链全部失败关闭。fixture 只能证明实现行为，不能生成真实 materialization 或独立 review。

当前已实现双观察 descriptor、规范化及编排 helper；固定根 CLI、实际 broker 执行/FD 注入、执行排他记录、materialization 和可信 receipt producer 尚未实现。先完成并审查这些源码和环境合同，再冻结具体工具路径/hash/源 closure/目标/opaque scope 的可执行包。之后分别取得原计划要求的凭据/controller 物化及只读操作授权，执行真实安装与 readback，最后回到完整 Task0B。不得现在对 metadata-only packet 请求安装。

本方案不授权复用现有 broad gh 凭据、不修改其权限、不生成新 token、不注册服务，也不改变后续 Task0C/0M、PR merge、保留数据库或 source branch 删除的授权门。
