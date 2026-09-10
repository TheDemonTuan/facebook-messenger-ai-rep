import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { SseProvider } from "./context/SseContext";
import { TimezoneProvider } from "./context/TimezoneContext";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/OverviewPage";
import { OperationsPage } from "./pages/OperationsPage";
import { InboxPage } from "./pages/InboxPage";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AuditPage } from "./pages/AuditPage";
import { LoginPage } from "./pages/LoginPage";

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <TimezoneProvider>
          <SseProvider>
            <Routes>
            <Route path="/login" element={<LoginPage />} />

            {/* Protected layout routes */}
            <Route
              path="/overview"
              element={
                <Layout>
                  <OverviewPage />
                </Layout>
              }
            />
            <Route
              path="/inbox"
              element={
                <Layout>
                  <InboxPage />
                </Layout>
              }
            />
            <Route
              path="/inbox/:conversationId"
              element={
                <Layout>
                  <ConversationDetailPage />
                </Layout>
              }
            />
            <Route
              path="/operations"
              element={
                <Layout>
                  <OperationsPage />
                </Layout>
              }
            />
            <Route path="/workflow" element={<Navigate to="/inbox" replace />} />
            <Route path="/queue" element={<Navigate to="/operations?tab=dispatch" replace />} />
            <Route path="/incidents" element={<Navigate to="/operations?tab=tech" replace />} />
            <Route path="/ai-logs" element={<Navigate to="/operations?tab=airuns" replace />} />
            <Route
              path="/settings"
              element={
                <Layout>
                  <SettingsPage />
                </Layout>
              }
            />
            <Route
              path="/audit"
              element={
                <Layout>
                  <AuditPage />
                </Layout>
              }
            />

            {/* Fallback redirect */}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </SseProvider>
      </TimezoneProvider>
    </AuthProvider>
  </BrowserRouter>
  );
};
