import { useTranslation } from "react-i18next";

import "@/App.css";

function App() {
  const { t } = useTranslation();
  return <>{t("appName")}</>;
}

export default App;
