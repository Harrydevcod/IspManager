package cv.novatech.ispm.sms.state

/** Sistema follows the phone, like the desktop follows Windows; the other two pin it. */
enum class ThemePref(val label: String) { SYSTEM("Sistema"), LIGHT("Claro"), DARK("Escuro") }

object ThemeRules {
  fun isDark(pref: ThemePref, systemDark: Boolean): Boolean = when (pref) {
    ThemePref.SYSTEM -> systemDark
    ThemePref.LIGHT -> false
    ThemePref.DARK -> true
  }

  /** The sun/moon button: always the opposite of what is on screen, pinned. */
  fun toggle(pref: ThemePref, systemDark: Boolean): ThemePref =
    if (isDark(pref, systemDark)) ThemePref.LIGHT else ThemePref.DARK

  fun parse(stored: String?): ThemePref = ThemePref.entries.firstOrNull { it.name == stored } ?: ThemePref.SYSTEM
}
