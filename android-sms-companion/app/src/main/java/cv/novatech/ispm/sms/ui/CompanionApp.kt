package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.ui.theme.Bg

@Composable
fun CompanionApp(
  state: CompanionUiState,
  onPaired: (PairingInfo) -> Unit,
  onInvalidPairing: () -> Unit,
  onRequestPermission: () -> Unit,
  onApprove: (String) -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit
) {
  Surface(Modifier.fillMaxSize().background(Bg)) {
    if (!state.paired) {
      OnboardingScreen(onPaired = onPaired, onInvalid = onInvalidPairing)
    } else {
      MainScreen(state, onRequestPermission, onApprove, onUndo, onReject)
    }
  }
}
