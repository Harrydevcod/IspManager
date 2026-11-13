package cv.novatech.ispm.sms.pairing

import cv.novatech.ispm.sms.state.PairingInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.spec.ECPrivateKeySpec

/** Mesmo vetor que src/backend/lib/sms-pairing.test.ts: os dois lados têm de bater ao byte. */
class PairingHandshakeTest {
  private val phonePriv = "1dabc4d56a5bee601f5cf6b62421750eac85b4e1702255e340d014e7de2af6fb"
  private val desktopPub = "BLLDVllTSnT_zl6OMuZ5sovQc6eI-vIONr41V4AoRoYVFfHTzbX6qGfBWltHik1t2KvgRr4T2QwZiZV-GcwuBgw"
  private val phonePub = "BGX00uurL4I9Lbdsp9JCHzZlQR7Al-zocrrLp6wcuO-xpejO9GZ9eDo7ZIdDF7oCSQfMQW2IHwGAWxJRhyMocHY"
  private val shared = "7e3f8ef013c7de7634b6e082b2484fc1f18f87fdbcead2307f45a2781d4c9e9c"
  private val secret = "d5b4abba5cfad173254fb66d142e953c15a6c189c8c6c02c9d07a317fa70f059"
  private val token = ByteArray(16) { (it + 1).toByte() }

  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

  @Test fun sharedSecretMatchesNode() {
    val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(phonePriv, 16), PairingHandshake.params()))
    val z = PairingHandshake.sharedSecret(priv, PairingHandshake.decode(PairingHandshake.fromB64url(desktopPub)))
    assertEquals(shared, hex(z))
  }

  @Test fun derivedKeysMatchNode() {
    val keys = PairingHandshake.derive(BigInteger(shared, 16).toByteArray().takeLast(32).toByteArray(), token)
    assertEquals(secret, keys.secret)
    assertEquals("063024", keys.sas)
  }

  @Test fun offerMacAndTokenHashMatchNode() {
    assertEquals(
      "a50e537a329533418dfcd37b1ec2be153a29604f1188b587a9e3128d2f642648",
      PairingHandshake.offerMac(secret, PairingHandshake.fromB64url(desktopPub), PairingHandshake.fromB64url(phonePub))
    )
    assertEquals("5dfbabeedf318bf33c0927c43d7630f5", PairingHandshake.tokenHash(token))
  }

  @Test fun publicKeyRoundTrips() {
    val raw = PairingHandshake.fromB64url(phonePub)
    assertEquals(phonePub, PairingHandshake.b64url(PairingHandshake.encode(PairingHandshake.decode(raw))))
  }

  @Test fun bothSidesOfARealHandshakeAgree() {
    val desktop = PairingHandshake.generateKeyPair()
    val info = PairingInfo.V2(PairingHandshake.encode(desktop.public), token, "PC")
    val pending = PendingPairing.start(info, now = 0)
    val z = PairingHandshake.sharedSecret(desktop.private, PairingHandshake.decode(pending.phonePub))
    val desktopKeys = PairingHandshake.derive(z, token)
    assertEquals(desktopKeys.secret, pending.secret)
    assertEquals(desktopKeys.sas, pending.sas)
    // A fresh QR never gives the same secret.
    assertNotEquals(pending.secret, PendingPairing.start(info, now = 0).secret)
  }

  @Test fun pendingWaitsForTheOperatorOnThePhone() {
    val desktop = PairingHandshake.generateKeyPair()
    val pending = PendingPairing.start(PairingInfo.V2(PairingHandshake.encode(desktop.public), token, "PC"), now = 0)
    assertEquals(false, pending.phoneConfirmed)
  }

  @Test fun pendingExpiresAfterTwoMinutes() {
    val desktop = PairingHandshake.generateKeyPair()
    val pending = PendingPairing.start(PairingInfo.V2(PairingHandshake.encode(desktop.public), token, "PC"), now = 1_000)
    assertEquals(true, pending.live(120_999))
    assertEquals(false, pending.live(121_000))
  }
}
