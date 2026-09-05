import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { SseProvider } from "./context/SseContext";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/OverviewPage";
import { InboxPage } from "./pages/InboxPage";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { QueuePage } from "./pages/QueuePage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { AiLogsPage } from "./pages/AiLogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AuditPage } from "./pages/AuditPage";
import { LoginPage } from "./pages/LoginPage";

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
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
              path="/queue"
              element={
                <Layout>
                  <QueuePage />
                </Layout>
              }
            />
            <Route
              path="/incidents"
              element={
                <Layout>
                  <IncidentsPage />
                </Layout>
              }
            />
            <Route
              path="/ai-logs"
              element={
                <Layout>
                  <AiLogsPage />
                </Layout>
              }
            />
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
      </AuthProvider>
    </BrowserRouter>
  );
};
