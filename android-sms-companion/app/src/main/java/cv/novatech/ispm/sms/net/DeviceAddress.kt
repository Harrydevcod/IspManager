package cv.novatech.ispm.sms.net

import java.net.Inet4Address
import java.net.NetworkInterface

/** Best-effort LAN IPv4 of this device, for display ("192.168.x.y:8765"). */
fun localIpv4(): String {
  return runCatching {
    NetworkInterface.getNetworkInterfaces().toList()
      .filter { it.isUp && !it.isLoopback }
      .flatMap { it.inetAddresses.toList() }
      .filterIsInstance<Inet4Address>()
      .firstOrNull { it.isSiteLocalAddress }?.hostAddress
  }.getOrNull() ?: "este dispositivo"
}
