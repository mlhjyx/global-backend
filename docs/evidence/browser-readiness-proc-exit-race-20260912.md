# Browser readiness proc-exit race

This is a diagnostic source receipt, not RuntimeEvidence or release acceptance.

The unchanged image `ghcr.io/mlhjyx/global-backend@sha256:4246f660eb2b38fec0a5ec1fb4edb855eb79098fa826e4311560b978f6131bdc`
binds source `5afc2f699b6fa0a6880441437c3b79248f349380`.
An isolated container used that image with init, no network, a read-only root,
1 GiB memory, two CPUs and private tmpfs. A test-only observer recorded bounded
child events and filesystem errno, without browser stderr or environment data.

At iteration 137, Chromium exited with code 0 after 799 ms and emitted close
after 812 ms. The subsequent read of `/proc/<pid>/stat` failed with `ESRCH`.
The production probe converted that error to `BROWSER_PROBE_CLEANUP_INCOMPLETE`,
retained the private root and fenced subsequent calls. No startup timeout was
involved. Increasing startup or reaping time therefore did not fix this path.

Linux proc files can report `ENOENT` if a PID disappears before open and `ESRCH`
if the process exits after its proc file is opened. Both mean that particular
process is gone. See the [Linux proc filesystem documentation](https://docs.kernel.org/filesystems/proc.html).

The correction recognizes only those two disappearance errors and continues
checking all remaining processes. Tests reproduce the ESRCH failure on the old
source, require a second call on the same probe to succeed after correction,
retain the cleanup fence for EACCES/EIO, and verify that a vanished PID cannot
hide a still-active group member. CI is configured to exercise the compiled product probe
200 times in its OCI image, including private-directory cleanup, instead of
launching Chromium once through a different command.

The corrected compiled module was mounted into the same isolated image for a
controlled comparison using the same observer and resource limits: 500 sequential
real Chromium probes completed with exit code 0. Focused tests passed 64/64;
probe coverage measured 98.38% lines and 94.28% branches. This comparison is a
candidate test, not adoption of a newly published image by the managed services.

This diagnosis does not establish platform authority readiness, matching Worker
admission, GrowthOS capability delivery or Site Builder UAT.
