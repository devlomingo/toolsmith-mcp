/** True for the loopback host names and addresses (IPv6 with or without brackets). */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
