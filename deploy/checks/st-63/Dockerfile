# The test container of ST-63 (deploy/checks/deploy-gate.mjs): an SSH server set up exactly as
# deploy/server/ describes it (the hardening drop-in and the deploy users' block, the forced
# command, the sudoers rule, the deploy and backup scripts, the systemd units), with a stand-in
# for docker and one for logger (no journal here). It never leaves the developer machine.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update \
 && apt-get install --yes --no-install-recommends openssh-server openssh-client sudo util-linux systemd \
 && rm -rf /var/lib/apt/lists/*
# confera-ssh: the only group sshd lets in (sshd-confera-hardening.conf). "outsider" has a key but
# is not in it.
RUN groupadd --system confera-ssh \
 && useradd --create-home --shell /bin/bash --groups confera-ssh confera-deploy-be \
 && useradd --create-home --shell /bin/bash --groups confera-ssh confera-deploy-web \
 && useradd --create-home --shell /bin/bash --groups confera-ssh tester \
 && useradd --create-home --shell /bin/bash outsider \
 && install -d -m 0755 /etc/ssh/confera-deploy /run/sshd /etc/confera /etc/fake-docker /srv/confera/deploy \
 && echo CONFERA_INSTANCE=staging >/srv/confera/compose.env \
 && ssh-keygen -A
COPY deploy/server/confera-deploy-gate /usr/local/sbin/confera-deploy-gate
COPY deploy/server/confera-deploy /usr/local/sbin/confera-deploy
COPY deploy/server/confera-backup /usr/local/sbin/confera-backup
COPY deploy/server/confera-backup.service deploy/server/confera-backup.timer /etc/systemd/system/
COPY deploy/server/sshd-confera-hardening.conf /etc/ssh/sshd_config.d/00-confera-hardening.conf
COPY deploy/server/sshd-confera-deploy.conf /etc/ssh/sshd_config.d/50-confera-deploy.conf
COPY deploy/server/sudoers-confera-deploy /etc/sudoers.d/confera-deploy
COPY deploy/server/deploy.conf.example /etc/confera/deploy.conf
COPY deploy/server/docker-daemon.json /etc/docker/daemon.json
COPY deploy/checks/st-63/fake-docker.sh /usr/local/bin/docker
COPY deploy/checks/st-63/fake-logger.sh /usr/local/bin/logger
COPY deploy/checks/st-63/scenarios.sh /usr/local/bin/st-63-scenarios
RUN chown root:root /usr/local/sbin/confera-deploy-gate /usr/local/sbin/confera-deploy /usr/local/sbin/confera-backup \
 && chmod 0755 /usr/local/sbin/confera-deploy-gate /usr/local/bin/docker /usr/local/bin/logger /usr/local/bin/st-63-scenarios \
 && chmod 0700 /usr/local/sbin/confera-deploy /usr/local/sbin/confera-backup \
 && chmod 0440 /etc/sudoers.d/confera-deploy \
 && sed -i 's/^CONFERA_INSTANCE=$/CONFERA_INSTANCE=staging/' /etc/confera/deploy.conf \
 && chmod 0644 /etc/confera/deploy.conf \
 && visudo -cf /etc/sudoers.d/confera-deploy \
 && sshd -t \
 && printf '[Service]\nExecStart=/bin/true\n' >/etc/systemd/system/docker.service \
 && node -e "JSON.parse(require('fs').readFileSync('/etc/docker/daemon.json', 'utf8'))" \
 && systemd-analyze verify /etc/systemd/system/confera-backup.service /etc/systemd/system/confera-backup.timer
CMD ["/usr/local/bin/st-63-scenarios"]
