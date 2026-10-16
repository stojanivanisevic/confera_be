// The address rule of the application (src/common/validation/mail-address.ts; ADR-09,
// ADR-13, SEC-A-17, ST-23) for the scripts, which run before anything is built: ONE plain
// ASCII address, a dot-atom local part, a domain of labels. A test of the tools holds the
// two equal (test/tooling/mail-address-rule.spec.ts).
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) {
    return false;
  }
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) {
    return false;
  }
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split('.');
  return (
    local.length <= 64 &&
    LOCAL.test(local) &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1] ?? '')
  );
}
