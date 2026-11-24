// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/**
 * @title TrustMarketsTrade
 * @notice Hybrid B2B Trade, Audit, Credit Pool & Cargo Insurance Contract on Base L2 (Trust Net v17.0)
 * @dev Covers Smart Contract Types 3, 4, 5, and 6:
 *      - Type 3: Hybrid Sale (With USDC Escrow OR Non-Escrow Net-30/60 Commercial Invoice Registry)
 *      - Type 4: Independent Auditor Validation & Quality Attestation
 *      - Type 5: Deal-Collateralized Credit Pool (USDC working capital into Escrow)
 *      - Type 6: Parametric Cargo & Logistics Insurance in USDC
 *      v17.0: 0.1% transaction fee (SETTLEMENT_FEE_BPS) is taken in USDC at escrow funding time
 *      (direct createDeal escrow or credit funding) and forwarded to the immutable treasury.
 *      Non-escrow Net-30/60 invoices carry no percentage (no USDC moves through the contract).
 */
contract TrustMarketsTrade {
    enum DealStatus {
        Created,
        FundedOrActive,
        Shipped,
        Audited,
        Settled,
        Disputed,
        Defaulted
    }

    struct TradeDeal {
        uint256 id;
        address buyer;
        address seller;
        address auditor;            // Type 4: Independent quality/warehouse validator
        address lender;             // Type 5: Credit provider (optional)
        address insurer;            // Type 6: Insurance provider (optional)
        uint256 amountUsdc;         // 6 decimals (Base USDC) — deal face value
        uint256 escrowedUsdc;       // USDC actually locked after the 0.1% fee (v17.0)
        uint256 creditPrincipalUsdc;
        uint256 insuranceCoverageUsdc;
        uint256 dueTimestamp;       // Net-30 / Net-60 maturity for non-escrow invoices
        bytes32 termsHash;          // IPFS/SHA-256 hash of Incoterms, SKU spec & JSON-LD offer
        bytes32 auditReportHash;    // Signed auditor inspection hash
        bool isEscrowEnabled;       // true = USDC locked in contract; false = Net-30/60 invoice registry
        bool settledOnTime;
        DealStatus status;
    }

    IERC20 public immutable usdc;
    address public immutable treasury;                  // fee recipient (platform, wallet B)
    uint16 public constant SETTLEMENT_FEE_BPS = 10;     // 0.1% (spec v17.0: $1 + 0.1% tariff grid)
    uint256 public nextDealId;

    mapping(uint256 => TradeDeal) internal deals; // explicit getDeal() accessor: 15 полей не влезают в авто-геттер
    mapping(address => uint256) public completedDealsCount;
    mapping(address => uint256) public auditedDealsCount;
    mapping(address => uint256) public onTimeInvoiceSettlements;

    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed seller,
        uint256 amountUsdc,
        bool isEscrowEnabled,
        uint256 dueTimestamp
    );
    event EscrowFunded(uint256 indexed dealId, address indexed funder, uint256 amountUsdc);
    event CreditProvided(uint256 indexed dealId, address indexed lender, uint256 principalUsdc);
    event InsuranceAttached(uint256 indexed dealId, address indexed insurer, uint256 coverageUsdc);
    event ShipmentConfirmed(uint256 indexed dealId, bytes32 billOfLadingHash);
    event AuditorVerified(uint256 indexed dealId, address indexed auditor, bytes32 reportHash);
    event DealSettled(uint256 indexed dealId, bool isEscrow, bool onTime);
    event SettlementFeeTaken(uint256 indexed dealId, address indexed treasury, uint256 feeUsdc);
    event InsuranceClaimPaid(uint256 indexed dealId, address indexed beneficiary, uint256 payoutUsdc);

    constructor(address _usdc, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury == address(0) ? msg.sender : _treasury;
    }

    /**
     * @dev Takes the 0.1% settlement fee (in BPS) from a funded escrow amount and forwards
     *      it to the treasury. Returns the net USDC that stays locked for the seller.
     */
    function _takeSettlementFee(uint256 dealId, uint256 amountUsdc) internal returns (uint256 netUsdc) {
        uint256 feeUsdc = (amountUsdc * SETTLEMENT_FEE_BPS) / 10_000;
        if (feeUsdc > 0) {
            require(usdc.transfer(treasury, feeUsdc), "Fee transfer to treasury failed");
            emit SettlementFeeTaken(dealId, treasury, feeUsdc);
        }
        return amountUsdc - feeUsdc;
    }

    /**
     * @notice Type 3: Create Hybrid B2B Trade Deal (Escrow or Net-30/60 Invoice)
     */
    function createDeal(
        address seller,
        address auditor,
        uint256 amountUsdc,
        uint256 netDays,
        bytes32 termsHash,
        bool isEscrowEnabled
    ) external returns (uint256 dealId) {
        require(seller != address(0) && seller != msg.sender, "Invalid seller");
        require(amountUsdc > 0, "Invalid amount");

        dealId = ++nextDealId;
        uint256 due = block.timestamp + (netDays * 1 days);

        // последовательные storage-присваивания вместо большого литерала: обходит "Stack too deep"
        TradeDeal storage d = deals[dealId];
        d.id = dealId;
        d.buyer = msg.sender;
        d.seller = seller;
        d.auditor = auditor;
        d.lender = address(0);
        d.insurer = address(0);
        d.amountUsdc = amountUsdc;
        d.escrowedUsdc = 0;
        d.creditPrincipalUsdc = 0;
        d.insuranceCoverageUsdc = 0;
        d.dueTimestamp = due;
        d.termsHash = termsHash;
        d.auditReportHash = bytes32(0);
        d.isEscrowEnabled = isEscrowEnabled;
        d.settledOnTime = false;
        d.status = isEscrowEnabled ? DealStatus.Created : DealStatus.FundedOrActive;

        if (isEscrowEnabled) {
            require(usdc.transferFrom(msg.sender, address(this), amountUsdc), "USDC escrow lock failed");
            d.escrowedUsdc = _takeSettlementFee(dealId, amountUsdc);
            d.status = DealStatus.FundedOrActive;
            emit EscrowFunded(dealId, msg.sender, amountUsdc);
        }

        emit DealCreated(dealId, msg.sender, seller, amountUsdc, isEscrowEnabled, due);
    }

    /**
     * @notice Type 5: Deal-Collateralized Credit Pool
     * @dev Lender funds an Escrow deal on behalf of the buyer, collateralized by the trade receivable.
     */
    function fundDealWithCredit(uint256 dealId) external {
        TradeDeal storage d = deals[dealId];
        require(d.isEscrowEnabled && d.status == DealStatus.Created, "Not eligible for credit funding");

        require(usdc.transferFrom(msg.sender, address(this), d.amountUsdc), "Credit transfer failed");
        d.escrowedUsdc = _takeSettlementFee(dealId, d.amountUsdc);
        d.lender = msg.sender;
        d.creditPrincipalUsdc = d.amountUsdc;
        d.status = DealStatus.FundedOrActive;

        emit CreditProvided(dealId, msg.sender, d.amountUsdc);
    }

    /**
     * @notice Type 6: Attach Cargo / Logistics Insurance Coverage in USDC
     */
    function attachInsurance(uint256 dealId, uint256 coverageUsdc) external {
        TradeDeal storage d = deals[dealId];
        require(d.status == DealStatus.FundedOrActive || d.status == DealStatus.Shipped, "Invalid state");
        require(usdc.transferFrom(msg.sender, address(this), coverageUsdc), "Insurance reserve lock failed");

        d.insurer = msg.sender;
        d.insuranceCoverageUsdc = coverageUsdc;

        emit InsuranceAttached(dealId, msg.sender, coverageUsdc);
    }

    /**
     * @notice Type 4: Independent Validator / Auditor Quality Attestation
     */
    function submitAuditorAttestation(uint256 dealId, bytes32 reportHash) external {
        TradeDeal storage d = deals[dealId];
        require(msg.sender == d.auditor, "Only designated auditor");
        require(d.status == DealStatus.FundedOrActive || d.status == DealStatus.Shipped, "Invalid deal status");

        d.auditReportHash = reportHash;
        d.status = DealStatus.Audited;

        auditedDealsCount[d.buyer]++;
        auditedDealsCount[d.seller]++;

        emit AuditorVerified(dealId, msg.sender, reportHash);
    }

    /**
     * @notice Settle Deal (Releases USDC in Escrow mode, or confirms Net-30/60 invoice payment in Non-Escrow mode)
     */
    function settleDeal(uint256 dealId) external {
        TradeDeal storage d = deals[dealId];
        require(
            d.status == DealStatus.FundedOrActive ||
            d.status == DealStatus.Shipped ||
            d.status == DealStatus.Audited,
            "Deal not active"
        );

        if (d.isEscrowEnabled) {
            require(msg.sender == d.buyer || msg.sender == d.auditor, "Only buyer or auditor can release escrow");
            require(usdc.transfer(d.seller, d.escrowedUsdc), "Escrow release failed");
            if (d.insuranceCoverageUsdc > 0 && d.insurer != address(0)) {
                require(usdc.transfer(d.insurer, d.insuranceCoverageUsdc), "Insurance reserve return failed");
            }
        } else {
            // Non-Escrow mode: Seller confirms receipt of SEPA / offchain / direct settlement
            require(msg.sender == d.seller, "Only seller can confirm non-escrow invoice settlement");
        }

        bool onTime = block.timestamp <= d.dueTimestamp;
        d.settledOnTime = onTime;
        d.status = DealStatus.Settled;

        completedDealsCount[d.buyer]++;
        completedDealsCount[d.seller]++;
        if (onTime) {
            onTimeInvoiceSettlements[d.buyer]++;
            onTimeInvoiceSettlements[d.seller]++;
        }

        emit DealSettled(dealId, d.isEscrowEnabled, onTime);
    }

    /**
     * @notice Полная запись сделки (замена авто-геттера: 15 полей структуры не собираются в стеке).
     */
    function getDeal(uint256 dealId) external view returns (TradeDeal memory) {
        return deals[dealId];
    }
}
