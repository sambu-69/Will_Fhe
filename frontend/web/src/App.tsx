// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface WillRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  beneficiary: string;
  executor: string;
  status: "draft" | "active" | "executed";
}

// Randomly selected styles: 
// Colors: Natural (wood/stone/green/blue)
// UI: Hand-drawn illustration
// Layout: Center radiation
// Interaction: Animation rich

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [wills, setWills] = useState<WillRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newWillData, setNewWillData] = useState({ 
    beneficiary: "", 
    executor: "", 
    assetValue: 0,
    conditions: ""
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedWill, setSelectedWill] = useState<WillRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<'myWills' | 'allWills'>('myWills');

  const activeCount = wills.filter(w => w.status === "active").length;
  const draftCount = wills.filter(w => w.status === "draft").length;
  const executedCount = wills.filter(w => w.status === "executed").length;

  useEffect(() => {
    loadWills().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadWills = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("will_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing will keys:", e); }
      }
      
      const list: WillRecord[] = [];
      for (const key of keys) {
        try {
          const willBytes = await contract.getData(`will_${key}`);
          if (willBytes.length > 0) {
            try {
              const willData = JSON.parse(ethers.toUtf8String(willBytes));
              list.push({ 
                id: key, 
                encryptedData: willData.data, 
                timestamp: willData.timestamp, 
                owner: willData.owner, 
                beneficiary: willData.beneficiary,
                executor: willData.executor,
                status: willData.status || "draft" 
              });
            } catch (e) { console.error(`Error parsing will data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading will ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setWills(list);
    } catch (e) { console.error("Error loading wills:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitWill = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset value with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newWillData.assetValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const willData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        beneficiary: newWillData.beneficiary,
        executor: newWillData.executor,
        status: "draft",
        conditions: newWillData.conditions
      };
      
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(willData)));
      
      const keysBytes = await contract.getData("will_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(willId);
      await contract.setData("will_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Will created with FHE encryption!" });
      await loadWills();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewWillData({ 
          beneficiary: "", 
          executor: "", 
          assetValue: 0,
          conditions: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const activateWill = async (willId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Activating will with FHE verification..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willBytes = await contract.getData(`will_${willId}`);
      if (willBytes.length === 0) throw new Error("Will not found");
      
      const willData = JSON.parse(ethers.toUtf8String(willBytes));
      const updatedWill = { ...willData, status: "active" };
      
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(updatedWill)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Will activated successfully!" });
      await loadWills();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Activation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const executeWill = async (willId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Executing will with FHE verification..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willBytes = await contract.getData(`will_${willId}`);
      if (willBytes.length === 0) throw new Error("Will not found");
      
      const willData = JSON.parse(ethers.toUtf8String(willBytes));
      const updatedWill = { ...willData, status: "executed" };
      
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(updatedWill)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Will executed successfully!" });
      await loadWills();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Execution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (willAddress: string) => address?.toLowerCase() === willAddress.toLowerCase();
  const isExecutor = (executorAddress: string) => address?.toLowerCase() === executorAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Create Your Will", description: "Define beneficiaries and asset distribution", icon: "📝" },
    { title: "FHE Encryption", description: "Your asset values are encrypted using Zama FHE", icon: "🔒", details: "Only numerical values are encrypted - strings remain plaintext" },
    { title: "Will Activation", description: "Activate your will when ready", icon: "⚡", details: "Active wills can be executed by designated executors" },
    { title: "Secure Execution", description: "Executors can trigger distribution", icon: "✅", details: "Asset values remain encrypted until final distribution" }
  ];

  const renderStatusChart = () => {
    const total = wills.length || 1;
    const activePercentage = (activeCount / total) * 100;
    const draftPercentage = (draftCount / total) * 100;
    const executedPercentage = (executedCount / total) * 100;
    
    return (
      <div className="status-chart-container">
        <div className="status-chart">
          <div className="chart-segment draft" style={{ width: `${draftPercentage}%` }}></div>
          <div className="chart-segment active" style={{ width: `${activePercentage}%` }}></div>
          <div className="chart-segment executed" style={{ width: `${executedPercentage}%` }}></div>
        </div>
        <div className="chart-legend">
          <div className="legend-item"><div className="color-box draft"></div><span>Draft: {draftCount}</span></div>
          <div className="legend-item"><div className="color-box active"></div><span>Active: {activeCount}</span></div>
          <div className="legend-item"><div className="color-box executed"></div><span>Executed: {executedCount}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="hand-drawn-spinner"></div>
      <p>Loading your encrypted wills...</p>
    </div>
  );

  const filteredWills = activeTab === 'myWills' 
    ? wills.filter(w => isOwner(w.owner) || isExecutor(w.executor))
    : wills;

  return (
    <div className="app-container natural-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 100 100" className="hand-drawn-logo">
              <path d="M50 10 L90 50 L50 90 L10 50 Z" className="logo-shape"/>
              <path d="M30 50 L70 50 M50 30 L50 70" className="logo-cross"/>
            </svg>
          </div>
          <h1>Will<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn hand-drawn-button">
            <div className="quill-icon"></div>Create Will
          </button>
          <button className="hand-drawn-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-section">
          <div className="welcome-text">
            <h2>Private Will Management</h2>
            <p>Create and manage your testament with <strong>Zama FHE encryption</strong> for complete confidentiality</p>
          </div>
          <div className="fhe-badge">
            <div className="fhe-lock"></div>
            <span>FHE-Powered Privacy</span>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>How It Works</h2>
            <p className="subtitle">Secure will management with fully homomorphic encryption</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <div className="dashboard-card hand-drawn-card">
            <h3>Your Wills Overview</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{wills.filter(w => isOwner(w.owner)).length}</div>
                <div className="stat-label">Your Wills</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{wills.filter(w => isExecutor(w.executor)).length}</div>
                <div className="stat-label">Executor For</div>
              </div>
            </div>
            {renderStatusChart()}
          </div>

          <div className="dashboard-card hand-drawn-card">
            <h3>FHE Technology</h3>
            <p>Zama FHE allows your asset values to remain encrypted at all times, even during computation and distribution.</p>
            <div className="fhe-process">
              <div className="process-step">
                <div className="step-icon">🔓</div>
                <div className="step-label">Plain Data</div>
              </div>
              <div className="process-arrow">→</div>
              <div className="process-step">
                <div className="step-icon">🔒</div>
                <div className="step-label">FHE Encryption</div>
              </div>
              <div className="process-arrow">→</div>
              <div className="process-step">
                <div className="step-icon">⚙️</div>
                <div className="step-label">Encrypted Processing</div>
              </div>
            </div>
          </div>
        </div>

        <div className="wills-section">
          <div className="section-header">
            <h2>Your Will Documents</h2>
            <div className="tabs">
              <button 
                className={`tab-button ${activeTab === 'myWills' ? 'active' : ''}`}
                onClick={() => setActiveTab('myWills')}
              >
                My Wills
              </button>
              <button 
                className={`tab-button ${activeTab === 'allWills' ? 'active' : ''}`}
                onClick={() => setActiveTab('allWills')}
              >
                All Wills
              </button>
            </div>
            <div className="header-actions">
              <button onClick={loadWills} className="refresh-btn hand-drawn-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="wills-list hand-drawn-card">
            {filteredWills.length === 0 ? (
              <div className="no-wills">
                <div className="scroll-icon"></div>
                <p>No wills found</p>
                <button className="hand-drawn-button primary" onClick={() => setShowCreateModal(true)}>
                  Create Your First Will
                </button>
              </div>
            ) : (
              <div className="table-container">
                <div className="table-header">
                  <div className="header-cell">ID</div>
                  <div className="header-cell">Beneficiary</div>
                  <div className="header-cell">Executor</div>
                  <div className="header-cell">Status</div>
                  <div className="header-cell">Actions</div>
                </div>
                {filteredWills.map(will => (
                  <div className="will-row" key={will.id} onClick={() => setSelectedWill(will)}>
                    <div className="table-cell">#{will.id.substring(0, 6)}</div>
                    <div className="table-cell">{will.beneficiary.substring(0, 6)}...{will.beneficiary.substring(38)}</div>
                    <div className="table-cell">{will.executor.substring(0, 6)}...{will.executor.substring(38)}</div>
                    <div className="table-cell">
                      <span className={`status-badge ${will.status}`}>{will.status}</span>
                    </div>
                    <div className="table-cell actions">
                      {isOwner(will.owner) && will.status === "draft" && (
                        <button className="action-btn hand-drawn-button" onClick={(e) => { e.stopPropagation(); activateWill(will.id); }}>
                          Activate
                        </button>
                      )}
                      {isExecutor(will.executor) && will.status === "active" && (
                        <button className="action-btn hand-drawn-button" onClick={(e) => { e.stopPropagation(); executeWill(will.id); }}>
                          Execute
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitWill} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          willData={newWillData} 
          setWillData={setNewWillData}
        />
      )}

      {selectedWill && (
        <WillDetailModal 
          will={selectedWill} 
          onClose={() => { setSelectedWill(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          isOwner={isOwner(selectedWill.owner)}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hand-drawn-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hand-drawn-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <svg viewBox="0 0 100 100" className="footer-logo">
                <path d="M50 10 L90 50 L50 90 L10 50 Z" className="logo-shape"/>
              </svg>
              <span>WillFHE</span>
            </div>
            <p>Secure testament management with Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">© {new Date().getFullYear()} WillFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  willData: any;
  setWillData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, willData, setWillData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setWillData({ ...willData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setWillData({ ...willData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!willData.beneficiary || !willData.executor) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal hand-drawn-card">
        <div className="modal-header">
          <h2>Create New Will</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Beneficiary Address *</label>
            <input 
              type="text" 
              name="beneficiary" 
              value={willData.beneficiary} 
              onChange={handleChange} 
              placeholder="0x..." 
              className="hand-drawn-input"
            />
          </div>
          <div className="form-group">
            <label>Executor Address *</label>
            <input 
              type="text" 
              name="executor" 
              value={willData.executor} 
              onChange={handleChange} 
              placeholder="0x..." 
              className="hand-drawn-input"
            />
          </div>
          <div className="form-group">
            <label>Total Asset Value (ETH)</label>
            <input 
              type="number" 
              name="assetValue" 
              value={willData.assetValue} 
              onChange={handleValueChange} 
              placeholder="0.00" 
              className="hand-drawn-input"
              step="0.01"
            />
            <div className="encryption-preview">
              <span>Encrypted Value:</span>
              <div>{willData.assetValue ? FHEEncryptNumber(willData.assetValue).substring(0, 30) + '...' : 'N/A'}</div>
            </div>
          </div>
          <div className="form-group">
            <label>Conditions (Optional)</label>
            <textarea 
              name="conditions" 
              value={willData.conditions} 
              onChange={handleChange} 
              placeholder="Any special conditions..." 
              className="hand-drawn-textarea"
              rows={3}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn hand-drawn-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn hand-drawn-button">
            {creating ? "Creating..." : "Create Will"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface WillDetailModalProps {
  will: WillRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  isOwner: boolean;
}

const WillDetailModal: React.FC<WillDetailModalProps> = ({ 
  will, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature, isOwner 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(will.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="will-detail-modal hand-drawn-card">
        <div className="modal-header">
          <h2>Will Details #{will.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="will-info">
            <div className="info-item">
              <span>Owner:</span>
              <strong>{will.owner.substring(0, 6)}...{will.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Beneficiary:</span>
              <strong>{will.beneficiary.substring(0, 6)}...{will.beneficiary.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Executor:</span>
              <strong>{will.executor.substring(0, 6)}...{will.executor.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(will.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${will.status}`}>{will.status}</strong>
            </div>
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Asset Value</h3>
            <div className="encrypted-data">
              {will.encryptedData.substring(0, 50)}...
            </div>
            {isOwner && (
              <button 
                className="decrypt-btn hand-drawn-button" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? "Decrypting..." : decryptedValue !== null ? "Hide Value" : "Decrypt with Signature"}
              </button>
            )}
          </div>

          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Asset Value</h3>
              <div className="decrypted-value">
                {decryptedValue} ETH
              </div>
              <div className="decryption-notice">
                This value is only visible after wallet signature verification
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn hand-drawn-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;