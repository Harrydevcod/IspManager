package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeRulesTest {
  @Test fun systemFollowsThePhone() {
    assertTrue(ThemeRules.isDark(ThemePref.SYSTEM, systemDark = true))
    assertFalse(ThemeRules.isDark(ThemePref.SYSTEM, systemDark = false))
  }

  @Test fun anExplicitChoiceWinsOverThePhone() {
    assertFalse(ThemeRules.isDark(ThemePref.LIGHT, systemDark = true))
    assertTrue(ThemeRules.isDark(ThemePref.DARK, systemDark = false))
  }

  @Test fun theButtonFlipsWhatIsOnScreen() {
    assertEquals(ThemePref.LIGHT, ThemeRules.toggle(ThemePref.SYSTEM, systemDark = true))
    assertEquals(ThemePref.DARK, ThemeRules.toggle(ThemePref.SYSTEM, systemDark = false))
    assertEquals(ThemePref.DARK, ThemeRules.toggle(ThemePref.LIGHT, systemDark = true))
  }

  @Test fun unknownOrMissingStoredValueIsSystem() {
    assertEquals(ThemePref.SYSTEM, ThemeRules.parse(null))
    assertEquals(ThemePref.SYSTEM, ThemeRules.parse("PURPLE"))
    assertEquals(ThemePref.LIGHT, ThemeRules.parse("LIGHT"))
  }
}
